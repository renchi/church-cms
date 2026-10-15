import { describe, expect, it, vi } from "vitest";
import { startOutboxRelay, type OutboxBatch, type OutboxRow, type OutboxStore } from "./outboxRelay.js";

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

// An in-memory store. `locked: true` plays another Pod's relay holding the lock.
function makeStore(
  rows: OutboxRow[],
  opts: { locked?: boolean } = {}
): OutboxStore & OutboxBatch & { published: string[] } {
  const published: string[] = [];
  const batch: OutboxBatch = {
    fetchPending: vi.fn(async (limit: number) => rows.filter((r) => !published.includes(r.id)).slice(0, limit)),
    markPublished: vi.fn(async (id: string) => {
      published.push(id);
    }),
  };
  return {
    published,
    ...batch,
    runExclusive: vi.fn(async (work) => (opts.locked ? null : work(batch))),
  };
}

const rows: OutboxRow[] = [
  { id: "1", subject: "cms.members.archived", payload: { n: 1 } },
  { id: "2", subject: "cms.members.archived", payload: { n: 2 } },
  { id: "3", subject: "cms.members.archived", payload: { n: 3 } },
];

describe("startOutboxRelay", () => {
  it("publishes pending rows in order, with the row id as the message id, and marks them", async () => {
    const store = makeStore(rows);
    const publish = vi.fn().mockResolvedValue(undefined);
    const relay = startOutboxRelay({ store, publish, log, autoStart: false });

    expect(await relay.runOnce()).toBe(3);
    expect(publish.mock.calls.map((c) => c[2])).toEqual(["1", "2", "3"]);
    expect(publish).toHaveBeenCalledWith("cms.members.archived", { n: 1 }, "1");
    expect(store.published).toEqual(["1", "2", "3"]);
    expect(await relay.runOnce()).toBe(0); // nothing left
  });

  it("stops the batch at the first failure so order is kept, and retries it next run", async () => {
    const store = makeStore(rows);
    const publish = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("NATS down"))
      .mockResolvedValue(undefined);
    const relay = startOutboxRelay({ store, publish, log, autoStart: false });

    expect(await relay.runOnce()).toBe(1);
    expect(store.published).toEqual(["1"]); // 2 failed, 3 wasn't attempted
    expect(await relay.runOnce()).toBe(2);
    expect(store.published).toEqual(["1", "2", "3"]);
  });

  it("does not mark a row published when publishing fails", async () => {
    const store = makeStore(rows.slice(0, 1));
    const relay = startOutboxRelay({
      store,
      publish: vi.fn().mockRejectedValue(new Error("NATS down")),
      log,
      autoStart: false,
    });

    await relay.runOnce();
    expect(store.markPublished).not.toHaveBeenCalled();
  });

  it("does nothing while another relay holds the lock", async () => {
    const store = makeStore(rows, { locked: true });
    const publish = vi.fn();
    const relay = startOutboxRelay({ store, publish, log, autoStart: false });

    expect(await relay.runOnce()).toBe(0);
    expect(publish).not.toHaveBeenCalled();
    expect(store.fetchPending).not.toHaveBeenCalled();
  });

  it("runs on a timer until stopped", async () => {
    vi.useFakeTimers();
    try {
      const store = makeStore(rows);
      const publish = vi.fn().mockResolvedValue(undefined);
      const relay = startOutboxRelay({ store, publish, log, intervalMs: 100, batchSize: 1 });

      await vi.advanceTimersByTimeAsync(350); // three ticks, one row each
      expect(store.published).toEqual(["1", "2", "3"]);

      await relay.stop();
      const calls = vi.mocked(store.fetchPending).mock.calls.length;
      await vi.advanceTimersByTimeAsync(500);
      expect(vi.mocked(store.fetchPending).mock.calls.length).toBe(calls);
    } finally {
      vi.useRealTimers();
    }
  });
});
