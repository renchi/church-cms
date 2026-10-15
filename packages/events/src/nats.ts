// Connecting to NATS and declaring the JetStream topology (ADR-0010).
//
// Both services call these at startup. Every function here is idempotent:
// "make it exist with this configuration", the same idea as
// `helm upgrade --install` or `kubectl apply`. Restarting a service, or
// starting both at once, is always safe.
import { connect, type NatsConnection } from "@nats-io/transport-node";
import {
  AckPolicy,
  DeliverPolicy,
  jetstream,
  JetStreamApiCodes,
  JetStreamApiError,
  jetstreamManager,
  StorageType,
  type JetStreamClient,
  type JetStreamManager,
} from "@nats-io/jetstream";

// The server answers a lookup for a missing stream or consumer with an API
// error carrying a numeric code. Anything else (no connection, no permission)
// is a real failure and must propagate.
function isApiError(err: unknown, code: number): boolean {
  return err instanceof JetStreamApiError && err.code === code;
}

export interface NatsHandles {
  nc: NatsConnection; // the raw connection (core NATS)
  js: JetStreamClient; // publish and consume persisted messages
  jsm: JetStreamManager; // admin API: create streams and consumers
}

// `name` shows up in the NATS server's connection list (`nats server report
// connections` in nats-box), so you can tell which service a connection is.
export async function connectNats(servers: string, name: string): Promise<NatsHandles> {
  const nc = await connect({
    servers,
    name,
    // Keep retrying forever if NATS restarts. Without this the client gives
    // up after a few attempts and the service would need a restart. The
    // outbox means nothing is lost while NATS is away.
    maxReconnectAttempts: -1,
    // If NATS isn't up yet when the service starts (common in Kubernetes,
    // where Pods start in any order), keep trying instead of failing.
    waitOnFirstConnect: true,
  });
  return { nc, js: jetstream(nc), jsm: await jetstreamManager(nc) };
}

// Create the stream, or bring an existing one to this configuration.
export async function ensureStream(
  jsm: JetStreamManager,
  stream: { name: string; subjects: readonly string[] }
): Promise<void> {
  const config = {
    subjects: [...stream.subjects],
    // File storage survives a NATS restart; memory storage would not.
    storage: StorageType.File,
    // Keep messages for 7 days. Longer than any outage we expect, so a
    // consumer that was down can still catch up when it comes back.
    max_age: 7 * 24 * 60 * 60 * 1_000_000_000, // nanoseconds, NATS's unit
    // How long JetStream remembers a Nats-Msg-Id to drop a re-publish.
    duplicate_window: 2 * 60 * 1_000_000_000,
  };
  try {
    await jsm.streams.info(stream.name);
    await jsm.streams.update(stream.name, config);
  } catch (err) {
    if (!isApiError(err, JetStreamApiCodes.StreamNotFound)) throw err;
    await jsm.streams.add({ name: stream.name, ...config });
  }
}

// Create a DURABLE consumer, or bring an existing one to this configuration.
// "Durable" means the server remembers, by name, which messages this consumer
// has acknowledged. A service that restarts picks up where it left off, and
// one that was down receives everything it missed: that is replay.
export async function ensureConsumer(
  jsm: JetStreamManager,
  opts: { stream: string; durable: string; filterSubject: string }
): Promise<void> {
  const config = {
    // Only messages on this subject. The stream may hold others.
    filter_subject: opts.filterSubject,
    // Every message must be acknowledged one by one. An unacknowledged message
    // is redelivered after ack_wait: this is "at least once" delivery.
    ack_policy: AckPolicy.Explicit,
    ack_wait: 30 * 1_000_000_000,
    // Redeliver for as long as it takes (-1 = no limit). A failure here is
    // transient (the database is restarting...), and a limit would silently
    // DROP valid messages after a long enough outage: with our backoff, 10
    // attempts last only ~2.5 minutes. Messages that can never succeed don't
    // loop: the consumer term()s them explicitly (see consumer.ts).
    max_deliver: -1,
  };
  try {
    await jsm.consumers.info(opts.stream, opts.durable);
    await jsm.consumers.update(opts.stream, opts.durable, config);
  } catch (err) {
    if (!isApiError(err, JetStreamApiCodes.ConsumerNotFound)) throw err;
    await jsm.consumers.add(opts.stream, {
      durable_name: opts.durable,
      // A brand-new consumer starts from the first message in the stream.
      // Fixed at creation, so it isn't in the update config above.
      deliver_policy: DeliverPolicy.All,
      ...config,
    });
  }
}

// Adapts the JetStream client to the relay's Publish function. `js.publish`
// resolves only after the stream has stored the message (a "PubAck"), so
// when it returns, the event is safely persisted in NATS.
export function jetStreamPublisher(js: JetStreamClient) {
  return async (subject: string, payload: unknown, msgId: string): Promise<void> => {
    await js.publish(subject, JSON.stringify(payload), { msgID: msgId });
  };
}
