// Consuming messages from a durable JetStream consumer (ADR-0010).
//
// JetStream delivers AT LEAST ONCE: a message stays "in flight" until we
// acknowledge it, and is redelivered if we don't (crash, timeout, nak). So
// every handler must be IDEMPOTENT: processing the same message twice must
// leave the same result as processing it once. Our handlers do that by
// recording the message id in a ProcessedMessage table, in the same database
// transaction as the change the message causes.
//
// After handling, every message gets exactly one of three answers:
//   ack()  — done (or already done before). Never deliver it again.
//   term() — it can NEVER be processed: bad JSON, unknown version. Retrying
//            won't help, so stop. It stays in the stream for inspection.
//   nak()  — failed this time (database down, ...). Redeliver it later.
import type { JetStreamClient } from "@nats-io/jetstream";
import { InvalidMessageError } from "./contract.js";
import type { Logger } from "./outboxRelay.js";

// The parts of a JetStream message (JsMsg) we use. A small interface lets the
// unit tests pass a fake message instead of running a NATS server.
export interface AckableMessage {
  subject: string;
  info: { deliveryCount: number; streamSequence: number };
  json<T = unknown>(): T;
  ack(): void;
  nak(millis?: number): void;
  term(reason?: string): void;
}

// Back off a little more on each attempt: 1 s, 2 s, 4 s ... capped at 30 s.
// Without a delay a failing message would be redelivered immediately, over
// and over, while the database is down.
export function nakDelayMs(deliveryCount: number): number {
  return Math.min(1000 * 2 ** (deliveryCount - 1), 30_000);
}

export async function handleMessage<T extends { id: string }>(
  msg: AckableMessage,
  parse: (raw: unknown) => T,
  handle: (event: T) => Promise<void>,
  log: Logger
): Promise<void> {
  const where = { subject: msg.subject, seq: msg.info.streamSequence, delivery: msg.info.deliveryCount };

  let event: T;
  try {
    event = parse(msg.json());
  } catch (err) {
    // msg.json() throws on invalid JSON; parse() throws InvalidMessageError.
    // Either way the bytes will never change, so retrying is pointless.
    log.error({ ...where, err }, "invalid message; terminating");
    msg.term(err instanceof Error ? err.message : "invalid message");
    return;
  }

  try {
    await handle(event);
    msg.ack();
    log.info({ ...where, messageId: event.id }, "message processed");
  } catch (err) {
    if (err instanceof InvalidMessageError) {
      log.error({ ...where, messageId: event.id, err }, "message rejected by handler; terminating");
      msg.term(err.message);
      return;
    }
    const delay = nakDelayMs(msg.info.deliveryCount);
    log.warn({ ...where, messageId: event.id, err, retryInMs: delay }, "message failed; will retry");
    msg.nak(delay);
  }
}

export interface RunningConsumer {
  stop(): Promise<void>;
}

// Starts pulling from an existing durable consumer (see ensureConsumer) and
// handles messages one at a time, in stream order.
//
// `onFailure` is called if the loop dies on its own: it throws, or it simply
// ends without stop() (e.g. someone deleted the durable consumer). Without
// this, the Pod would keep serving HTTP and stay Ready while silently never
// processing another message. The services exit, so Kubernetes restarts the
// Pod and ensureConsumer recreates whatever was missing.
export async function runConsumer<T extends { id: string }>(opts: {
  js: JetStreamClient;
  stream: string;
  durable: string;
  parse: (raw: unknown) => T;
  handle: (event: T) => Promise<void>;
  log: Logger;
  onFailure: (err: Error) => void;
}): Promise<RunningConsumer> {
  const consumer = await opts.js.consumers.get(opts.stream, opts.durable);
  // consume() is a PULL consumer: the client asks the server for messages in
  // batches (max_messages) as it processes them, so a slow service is never
  // flooded. The opposite, a push consumer, has the server send as fast as it can.
  //
  // abort_on_missing_resource: if the consumer or stream is deleted, end the
  // iterator instead of quietly retrying forever, so onFailure fires.
  const messages = await consumer.consume({ max_messages: 10, abort_on_missing_resource: true });

  let stopping = false;
  const loop = (async () => {
    try {
      for await (const msg of messages) {
        await handleMessage(msg, opts.parse, opts.handle, opts.log);
      }
      if (!stopping) throw new Error(`consumer ${opts.durable} on ${opts.stream} ended unexpectedly`);
    } catch (err) {
      if (stopping) return;
      opts.onFailure(err instanceof Error ? err : new Error(String(err)));
    }
  })();

  return {
    async stop() {
      stopping = true;
      // close() ends the for-await loop after the current message.
      await messages.close();
      await loop;
    },
  };
}
