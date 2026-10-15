// Wires members-service to NATS (ADR-0010):
//   publishes — MemberArchived, from the outbox, onto the MEMBERS stream
//   consumes  — AttendanceRecorded, from the EVENTS stream, into the
//               attendance summary on Member
//
// It runs alongside the HTTP server and never blocks it. While NATS is
// unreachable, archiving a member still works: the event waits in the
// OutboxMessage table, and the relay publishes it once NATS is back.
import {
  connectNats,
  ensureConsumer,
  ensureStream,
  jetStreamPublisher,
  parseAttendanceRecorded,
  runConsumer,
  startOutboxRelay,
  STREAMS,
  SUBJECTS,
  type Logger,
} from "@cms/events";
import type { PrismaClient } from "./prisma.js";
import { RecordAttendanceInSummaryUseCase } from "../application/RecordAttendanceInSummaryUseCase.js";
import { PrismaOutboxStore } from "./outbox.js";
import { PrismaUnitOfWork } from "./PrismaUnitOfWork.js";

// The durable consumer's name. JetStream tracks progress per name, so this
// must stay the same across restarts and deploys, or the service would
// replay the whole stream as a "new" consumer.
const DURABLE = "members-service";

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
  const nats = await connectNats(natsUrl, "members-service");
  log.info({ natsUrl }, "connected to NATS");

  // Both streams are declared here, not only our own. The configuration comes
  // from the shared contract, so whichever service starts first creates them
  // and the other's call is a no-op. Neither service has to start first.
  await ensureStream(nats.jsm, STREAMS.members);
  await ensureStream(nats.jsm, STREAMS.events);
  await ensureConsumer(nats.jsm, {
    stream: STREAMS.events.name,
    durable: DURABLE,
    filterSubject: SUBJECTS.attendanceRecorded,
  });

  const relay = startOutboxRelay({
    store: new PrismaOutboxStore(prisma),
    publish: jetStreamPublisher(nats.js),
    log,
  });

  const recordAttendance = new RecordAttendanceInSummaryUseCase(new PrismaUnitOfWork(prisma));
  const consumer = await runConsumer({
    js: nats.js,
    stream: STREAMS.events.name,
    durable: DURABLE,
    parse: parseAttendanceRecorded,
    // Wire format → use case input. The use case never sees the envelope.
    handle: async (msg) => {
      const outcome = await recordAttendance.execute({
        messageId: msg.id,
        memberId: msg.data.memberId,
        checkedInAt: new Date(msg.data.checkedInAt),
      });
      if (outcome !== "applied") {
        log.warn({ messageId: msg.id, memberId: msg.data.memberId, outcome }, "attendance not applied");
      }
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
