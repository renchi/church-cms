// Wires events-service to NATS (ADR-0010):
//   publishes — AttendanceRecorded, from the outbox, onto the EVENTS stream
//   consumes  — MemberArchived, from the MEMBERS stream: declines the
//               member's future volunteer assignments (ADR-0004)
//
// It runs alongside the HTTP server and never blocks it. While NATS is
// unreachable, check-ins still work: the event waits in the OutboxMessage
// table, and the relay publishes it once NATS is back.
import {
  connectNats,
  ensureConsumer,
  ensureStream,
  inSpan,
  jetStreamPublisher,
  parseMemberArchived,
  runConsumer,
  startOutboxRelay,
  STREAMS,
  SUBJECTS,
  type Logger,
} from "@cms/events";
import { DeclineAssignmentsForArchivedMemberUseCase } from "../application/DeclineAssignmentsForArchivedMemberUseCase.js";
import { PrismaOutboxStore } from "./outbox.js";
import type { PrismaClient } from "./prisma.js";
import { PrismaUnitOfWork } from "./PrismaUnitOfWork.js";

// The durable consumer's name. JetStream tracks progress per name, so this
// must stay the same across restarts and deploys, or the service would
// replay the whole stream as a "new" consumer.
const DURABLE = "events-service";

export interface Messaging {
  stop(): Promise<void>;
}

export async function startMessaging(opts: {
  natsUrl: string;
  prisma: PrismaClient;
  log: Logger;
  // Called if the consumer dies on its own (see runConsumer in @cms/events).
  onFailure: (err: Error) => void;
}): Promise<Messaging> {
  const { natsUrl, prisma, log, onFailure } = opts;
  const nats = await connectNats(natsUrl, "events-service");
  log.info({ natsUrl }, "connected to NATS");

  // Both streams are declared here, not only our own. The configuration comes
  // from the shared contract, so whichever service starts first creates them
  // and the other's call is a no-op. Neither service has to start first.
  await ensureStream(nats.jsm, STREAMS.events);
  await ensureStream(nats.jsm, STREAMS.members);
  await ensureConsumer(nats.jsm, {
    stream: STREAMS.members.name,
    durable: DURABLE,
    filterSubject: SUBJECTS.memberArchived,
  });

  const relay = startOutboxRelay({
    store: new PrismaOutboxStore(prisma),
    publish: jetStreamPublisher(nats.js),
    log,
  });

  const declineAssignments = new DeclineAssignmentsForArchivedMemberUseCase(new PrismaUnitOfWork(prisma));
  const consumer = await runConsumer({
    js: nats.js,
    stream: STREAMS.members.name,
    durable: DURABLE,
    parse: parseMemberArchived,
    // Wire format → use case input. The use case never sees the envelope.
    // The use-case span nests under the consumer's `process` span, like the
    // HTTP routes' use-case spans nest under the request (eventRoutes.ts).
    handle: async (msg) => {
      const result = await inSpan("DeclineAssignmentsForArchivedMemberUseCase", {}, () =>
        declineAssignments.execute({ messageId: msg.id, memberId: msg.data.memberId })
      );
      log.info({ messageId: msg.id, memberId: msg.data.memberId, ...result }, "member archived handled");
    },
    log,
    onFailure,
  });

  return {
    async stop() {
      await consumer.stop();
      await relay.stop();
      // drain() lets in-flight messages finish, then closes the connection.
      await nats.nc.drain();
    },
  };
}
