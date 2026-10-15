// The outbox relay: moves saved events from a service's outbox table to NATS.
//
// THE PROBLEM (the "dual write"): a use case must change the database AND
// publish an event. Those are two systems, so there is no single transaction
// across them. Publish first and then crash: the event announces a change that
// was never saved. Save first and then crash: the change happened, but the
// other context never hears about it.
//
// THE FIX (the "transactional outbox"): the repository writes the event into
// an `OutboxMessage` table in the SAME database transaction as the aggregate.
// Now the change and the event are saved together, or not at all. This relay
// then publishes the outbox rows and marks each one published.
//
// If the relay crashes between publishing and marking, the row is published
// again on the next run. That's why the row id travels as the Nats-Msg-Id
// header: JetStream drops a second message with the same id (within the
// stream's duplicate_window), and consumers dedupe by id as a backstop.
//
// ONE RELAY AT A TIME: every Pod of a service runs this relay, over the same
// table. If they all published every row, each row would go out once per Pod,
// and two Pods working at different speeds could mix up the order. So each
// batch runs inside store.runExclusive(): only one relay per service holds the
// lock at a time (a Postgres advisory lock), and the others skip that tick.
//
// This file knows nothing about Prisma: each service hands it an OutboxStore
// over its own table, so the shared package never touches a service's database.

export interface OutboxRow {
  id: string;
  subject: string;
  payload: unknown; // the wire event (see contract.ts), stored as JSON
}

// What one relay batch can do, while it holds the lock.
export interface OutboxBatch {
  // Oldest first, so events are published in the order they happened.
  fetchPending(limit: number): Promise<OutboxRow[]>;
  markPublished(id: string, publishedAt: Date): Promise<void>;
}

export interface OutboxStore {
  // Runs `work` while holding a lock that only one relay of this service can
  // hold at a time. Returns null, without running `work`, if another relay
  // has it right now.
  runExclusive<T>(work: (batch: OutboxBatch) => Promise<T>): Promise<T | null>;
}

// Publishes one message and resolves once JetStream has stored it.
export type Publish = (subject: string, payload: unknown, msgId: string) => Promise<void>;

// The subset of pino's API we use. Fastify's `app.log` satisfies it.
export interface Logger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface OutboxRelay {
  // Publishes one batch; returns how many rows were published. Exposed so
  // tests can drive the relay step by step instead of waiting on a timer.
  runOnce(): Promise<number>;
  // Stops the loop and waits for an in-flight batch to finish.
  stop(): Promise<void>;
}

export function startOutboxRelay(opts: {
  store: OutboxStore;
  publish: Publish;
  log: Logger;
  intervalMs?: number;
  batchSize?: number;
  // false = don't start the timer; the caller drives runOnce() (tests).
  autoStart?: boolean;
}): OutboxRelay {
  const intervalMs = opts.intervalMs ?? 1000;
  const batchSize = opts.batchSize ?? 50;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<number> = Promise.resolve(0);

  async function runOnce(): Promise<number> {
    const published = await opts.store.runExclusive(async (batch) => {
      const rows = await batch.fetchPending(batchSize);
      let count = 0;
      for (const row of rows) {
        try {
          await opts.publish(row.subject, row.payload, row.id);
        } catch (err) {
          // NATS is unreachable or slow. Stop this batch rather than skip the
          // row, so events keep their order; the next tick retries from here.
          opts.log.warn({ err, outboxId: row.id, subject: row.subject }, "outbox publish failed; will retry");
          break;
        }
        await batch.markPublished(row.id, new Date());
        count++;
      }
      return count;
    });
    // null: another Pod's relay is running a batch right now. Nothing to do.
    if (published) opts.log.info({ published }, "outbox events published");
    return published ?? 0;
  }

  // A chain of setTimeouts rather than setInterval: the next run is scheduled
  // only after the current one finishes, so two batches never overlap.
  function schedule(): void {
    if (stopped) return;
    timer = setTimeout(() => {
      inFlight = runOnce().catch((err: unknown) => {
        // e.g. the database is down. Log and keep looping.
        opts.log.error({ err }, "outbox relay run failed");
        return 0;
      });
      void inFlight.then(schedule);
    }, intervalMs);
  }

  if (opts.autoStart ?? true) schedule();

  return {
    runOnce,
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await inFlight;
    },
  };
}
