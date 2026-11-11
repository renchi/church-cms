// The business metrics the relay and the consumer record (metrics.ts, CMS-31).
//
// A real OTel MeterProvider with a reader we pull from by hand, the way
// Prometheus pulls from the exporter on each scrape. A file of its own: it
// installs a global MeterProvider, which would leak into the other test files'
// assumptions if it lived there.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { metrics } from "@opentelemetry/api";
import { MeterProvider, MetricReader, type DataPoint, type Histogram } from "@opentelemetry/sdk-metrics";
import { handleMessage, type AckableMessage } from "./consumer.js";
import { parseMemberArchived } from "./contract.js";
import { resetMessagingInstruments } from "./metrics.js";
import { startOutboxRelay, type OutboxBatch, type OutboxRow, type OutboxStats } from "./outboxRelay.js";

// A reader that only collects when asked.
class PullReader extends MetricReader {
  protected async onForceFlush(): Promise<void> {}
  protected async onShutdown(): Promise<void> {}
}

let reader: PullReader;
beforeEach(() => {
  // A fresh provider per test, so counts start at zero.
  metrics.disable();
  resetMessagingInstruments();
  reader = new PullReader();
  metrics.setGlobalMeterProvider(new MeterProvider({ readers: [reader] }));
});
afterAll(() => metrics.disable());

// The points of one metric, as { attributes, value } pairs.
async function points(name: string): Promise<DataPoint<unknown>[]> {
  const { resourceMetrics } = await reader.collect();
  const metric = resourceMetrics.scopeMetrics.flatMap((s) => s.metrics).find((m) => m.descriptor.name === name);
  return (metric?.dataPoints ?? []) as DataPoint<unknown>[];
}

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe("outbox relay metrics", () => {
  const savedAt = new Date(Date.now() - 3000); // waited 3 s in the outbox
  const row: OutboxRow = { id: "1", subject: "cms.members.registered", payload: {}, traceparent: null, createdAt: savedAt };

  function store(stats: OutboxStats | Error) {
    const batch: OutboxBatch = { fetchPending: async () => [row], markPublished: async () => {} };
    return {
      runExclusive: async <T>(work: (b: OutboxBatch) => Promise<T>) => work(batch),
      stats: async () => {
        if (stats instanceof Error) throw stats;
        return stats;
      },
    };
  }

  it("counts each publish by subject and records how long the row waited", async () => {
    const relay = startOutboxRelay({
      store: store({ rows: [], oldestPendingAt: null }),
      publish: async () => {},
      log,
      autoStart: false,
    });
    await relay.runOnce();

    expect(await points("outbox.published")).toMatchObject([
      { attributes: { subject: "cms.members.registered" }, value: 1 },
    ]);
    const [delay] = await points("outbox.publish.delay");
    const h = delay.value as Histogram;
    expect(h.count).toBe(1);
    expect(h.sum).toBeGreaterThanOrEqual(3);
    expect(h.sum).toBeLessThan(5);
    await relay.stop();
  });

  it("reports the table's rows and the oldest pending row's age on each collection", async () => {
    const relay = startOutboxRelay({
      store: store({
        rows: [
          { subject: "cms.members.registered", state: "published", count: 12 },
          { subject: "cms.members.registered", state: "pending", count: 2 },
        ],
        oldestPendingAt: new Date(Date.now() - 60_000),
      }),
      publish: async () => {},
      log,
      autoStart: false,
    });

    expect(await points("outbox.rows")).toMatchObject([
      { attributes: { subject: "cms.members.registered", state: "published" }, value: 12 },
      { attributes: { subject: "cms.members.registered", state: "pending" }, value: 2 },
    ]);
    const [age] = await points("outbox.oldest_pending.age");
    expect(age.value).toBeGreaterThanOrEqual(60);
    await relay.stop();
  });

  // Found in CMS-31: the OTel SDK keeps reporting the LAST value of an attribute set
  // that a callback stops observing. Once the last pending row was published, the
  // GROUP BY returned no "pending" row, so the gauge stuck at its old value forever.
  it("reports 0 pending once the last pending row is published, not the old value", async () => {
    let stats: OutboxStats = {
      rows: [
        { subject: "cms.members.registered", state: "published", count: 5 },
        { subject: "cms.members.registered", state: "pending", count: 1 },
      ],
      oldestPendingAt: new Date(),
    };
    const relay = startOutboxRelay({
      store: { ...store(stats), stats: async () => stats },
      publish: async () => {},
      log,
      autoStart: false,
    });
    await points("outbox.rows");

    stats = { rows: [{ subject: "cms.members.registered", state: "published", count: 6 }], oldestPendingAt: null };

    expect(await points("outbox.rows")).toMatchObject([
      { attributes: { subject: "cms.members.registered", state: "published" }, value: 6 },
      { attributes: { subject: "cms.members.registered", state: "pending" }, value: 0 },
    ]);
    await relay.stop();
  });

  it("reports nothing (a gap, not a 0) when the table can't be read, and stops reporting after stop()", async () => {
    const relay = startOutboxRelay({ store: store(new Error("database down")), publish: async () => {}, log, autoStart: false });
    expect(await points("outbox.oldest_pending.age")).toEqual([]);
    expect(log.warn).toHaveBeenCalledWith(expect.anything(), "outbox stats unavailable");
    await relay.stop();

    const stopped = startOutboxRelay({ store: store({ rows: [], oldestPendingAt: null }), publish: async () => {}, log, autoStart: false });
    await stopped.stop();
    expect(await points("outbox.oldest_pending.age")).toEqual([]);
  });
});

describe("consumer metrics", () => {
  const valid = { id: "msg-1", type: "MemberArchived", version: 1, occurredAt: "2026-10-15T10:00:00.000Z", data: { memberId: "m-1" } };
  const message = (body: unknown): AckableMessage => ({
    subject: "cms.members.archived",
    info: { deliveryCount: 1, streamSequence: 1 },
    json: <T>() => body as T,
    ack: vi.fn(),
    nak: vi.fn(),
    term: vi.fn(),
  });

  it("counts each message by subject and outcome: the handler's answer, rejected or retried", async () => {
    await handleMessage(message(valid), parseMemberArchived, async () => "applied", log);
    await handleMessage(message(valid), parseMemberArchived, async () => "duplicate", log);
    await handleMessage(message(valid), parseMemberArchived, async () => {}, log); // no answer = applied
    await handleMessage(message({ nope: true }), parseMemberArchived, async () => "applied", log);
    await handleMessage(message(valid), parseMemberArchived, () => Promise.reject(new Error("database down")), log);

    const byOutcome = Object.fromEntries(
      (await points("messages.consumed")).map((p) => [p.attributes.outcome, p.value])
    );
    expect(byOutcome).toEqual({ applied: 2, duplicate: 1, rejected: 1, retried: 1 });
  });
});
