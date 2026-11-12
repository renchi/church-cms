// Wires communications-service to NATS (ADR-0010):
//   consumes  — MemberRegistered, from the MEMBERS stream, into a welcome email
//   publishes — nothing (no other context needs to hear from Communications yet,
//               so there's no outbox and no relay here; ADR-0005's CMS-20 addendum)
//
// It runs alongside the HTTP server and never blocks it.
import {
  connectNats,
  DeliverPolicy,
  ensureConsumer,
  ensureStream,
  inSpan,
  InvalidMessageError,
  parseMemberRegistered,
  runConsumer,
  STREAMS,
  SUBJECTS,
  type Logger,
} from "@cms/events";
import { SendWelcomeEmailUseCase } from "../application/SendWelcomeEmailUseCase.js";
import { MemberNotFoundError } from "../domain/errors.js";
import { HttpRecipientResolver } from "./HttpRecipientResolver.js";
import type { PrismaClient } from "./prisma.js";
import { PrismaUnitOfWork } from "./PrismaUnitOfWork.js";
import { PrismaWelcomeEmailRepository } from "./PrismaWelcomeEmailRepository.js";
import { SmtpEmailSender } from "./SmtpEmailSender.js";

// The durable consumer's name. JetStream remembers progress per name, so it must
// stay the same across restarts and deploys. Both Pods use it: JetStream hands
// each message to ONE of them, like a work queue.
const DURABLE = "communications-service";

export interface Messaging {
  stop(): Promise<void>;
}

export interface MessagingConfig {
  natsUrl: string;
  membersApiUrl: string;
  smtp: { host: string; port: number; from: string };
  churchName: string;
}

export async function startMessaging(opts: {
  config: MessagingConfig;
  prisma: PrismaClient;
  log: Logger;
  // Called if the consumer dies on its own (see runConsumer in @cms/events).
  onFailure: (err: Error) => void;
}): Promise<Messaging> {
  const { config, prisma, log, onFailure } = opts;
  const nats = await connectNats(config.natsUrl, "communications-service");
  log.info({ natsUrl: config.natsUrl }, "connected to NATS");

  // MEMBERS is declared with the shared config, so starting before
  // members-service is fine. Communications doesn't publish, so it doesn't
  // declare EVENTS.
  await ensureStream(nats.jsm, STREAMS.members);
  await ensureConsumer(nats.jsm, {
    stream: STREAMS.members.name,
    durable: DURABLE,
    filterSubject: SUBJECTS.memberRegistered,
    // Only registrations from now on. Without it, the first start would send a
    // late welcome email to everyone who registered in the last 7 days (the
    // stream's max_age). Applied only when the consumer is created.
    deliverPolicy: DeliverPolicy.New,
  });

  const sendWelcome = new SendWelcomeEmailUseCase(
    new PrismaWelcomeEmailRepository(prisma),
    new HttpRecipientResolver(config.membersApiUrl),
    new SmtpEmailSender(config.smtp),
    new PrismaUnitOfWork(prisma),
    { churchName: config.churchName }
  );

  const consumer = await runConsumer({
    js: nats.js,
    stream: STREAMS.members.name,
    durable: DURABLE,
    parse: parseMemberRegistered,
    // Wire format → use case input. The use case never sees the envelope.
    // Its answer (sent | skipped | duplicate) becomes the `outcome` label of
    // messages_consumed_total. Errors decide NATS's answer (consumer.ts):
    //   MemberNotFoundError        → InvalidMessageError → term (never retried)
    //   RecipientsUnavailableError → nak: retried with backoff until Members answers
    //   an SMTP or database error  → nak: retried the same way
    handle: async (msg) => {
      try {
        const outcome = await inSpan("SendWelcomeEmailUseCase", {}, () =>
          sendWelcome.execute({ messageId: msg.id, memberId: msg.data.memberId })
        );
        // The id only: the member's email address is personal data, and must not
        // be copied into the logs (study-guide §9.9).
        log.info({ messageId: msg.id, memberId: msg.data.memberId, outcome }, "welcome email handled");
        return outcome;
      } catch (err) {
        if (err instanceof MemberNotFoundError) throw new InvalidMessageError(err.message);
        throw err;
      }
    },
    log,
    onFailure,
  });

  return {
    async stop() {
      await consumer.stop();
      // drain() lets an in-flight message finish, then closes the connection.
      await nats.nc.drain();
    },
  };
}
