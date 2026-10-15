// Runs the NATS plumbing against a real NATS server in Docker (Testcontainers).
// These are the guarantees ADR-0010 relies on, so they're tested for real
// rather than with fakes: idempotent setup, Nats-Msg-Id deduplication, and
// replay to a durable consumer that was stopped while messages arrived.
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { STREAMS, SUBJECTS, parseMemberArchived, type MemberArchivedV1 } from "./contract.js";
import { runConsumer } from "./consumer.js";
import { connectNats, ensureConsumer, ensureStream, jetStreamPublisher, type NatsHandles } from "./nats.js";

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function archived(id: string, memberId: string): MemberArchivedV1 {
  return { id, type: "MemberArchived", version: 1, occurredAt: new Date().toISOString(), data: { memberId } };
}

// Polls until `check` passes or the timeout runs out: consumers are async.
async function eventually(check: () => void, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      check();
      return;
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

describe("NATS JetStream plumbing", () => {
  let container: StartedTestContainer;
  let nats: NatsHandles;

  beforeAll(async () => {
    // -js turns JetStream on. Without it the server is core NATS only.
    container = await new GenericContainer("nats:2.15.0-alpine")
      .withCommand(["-js"])
      .withExposedPorts(4222)
      .withWaitStrategy(Wait.forLogMessage(/Server is ready/))
      .start();
    nats = await connectNats(`nats://${container.getHost()}:${container.getMappedPort(4222)}`, "test");
  }, 60_000);

  afterAll(async () => {
    await nats?.nc.drain();
    await container?.stop();
  });

  it("ensureStream and ensureConsumer are idempotent", async () => {
    await ensureStream(nats.jsm, STREAMS.members);
    await ensureStream(nats.jsm, STREAMS.members); // second run: update, no error
    const opts = { stream: STREAMS.members.name, durable: "idempotent-check", filterSubject: SUBJECTS.memberArchived };
    await ensureConsumer(nats.jsm, opts);
    await ensureConsumer(nats.jsm, opts);

    const info = await nats.jsm.streams.info(STREAMS.members.name);
    expect(info.config.subjects).toEqual(["cms.members.>"]);
  });

  it("drops a re-publish with the same message id", async () => {
    await ensureStream(nats.jsm, STREAMS.members);
    const publish = jetStreamPublisher(nats.js);
    const before = (await nats.jsm.streams.info(STREAMS.members.name)).state.messages;

    await publish(SUBJECTS.memberArchived, archived("dup-1", "m-1"), "dup-1");
    await publish(SUBJECTS.memberArchived, archived("dup-1", "m-1"), "dup-1"); // the relay retrying

    const after = (await nats.jsm.streams.info(STREAMS.members.name)).state.messages;
    expect(after - before).toBe(1);
  });

  it("replays messages published while a durable consumer was stopped", async () => {
    await ensureStream(nats.jsm, STREAMS.members);
    const durable = "replay-check";
    await ensureConsumer(nats.jsm, { stream: STREAMS.members.name, durable, filterSubject: SUBJECTS.memberArchived });
    const publish = jetStreamPublisher(nats.js);
    const seen: string[] = [];
    const start = () =>
      runConsumer({
        js: nats.js,
        stream: STREAMS.members.name,
        durable,
        parse: parseMemberArchived,
        handle: async (e) => {
          seen.push(e.id);
        },
        log,
        onFailure: (err) => {
          throw err;
        },
      });

    // The consumer was created after earlier tests published, so it first
    // receives those (deliver_policy: all). Drain them before counting.
    let consumer = await start();
    await publish(SUBJECTS.memberArchived, archived("r-1", "m-1"), "r-1");
    await eventually(() => expect(seen).toContain("r-1"));
    await consumer.stop();

    // The service is "down": these are stored by JetStream, not delivered.
    await publish(SUBJECTS.memberArchived, archived("r-2", "m-2"), "r-2");
    await publish(SUBJECTS.memberArchived, archived("r-3", "m-3"), "r-3");

    const before = seen.length;
    consumer = await start(); // "restart": same durable name, picks up where it left off
    await eventually(() => expect(seen.slice(before)).toEqual(["r-2", "r-3"]));
    await consumer.stop();
    expect(seen.filter((id) => id === "r-1")).toHaveLength(1); // acked, so not redelivered
  });

  it("reports a failure when its durable consumer is deleted, instead of going quiet", async () => {
    await ensureStream(nats.jsm, STREAMS.members);
    const durable = "deleted-check";
    await ensureConsumer(nats.jsm, { stream: STREAMS.members.name, durable, filterSubject: SUBJECTS.memberArchived });
    const onFailure = vi.fn();
    await runConsumer({
      js: nats.js,
      stream: STREAMS.members.name,
      durable,
      parse: parseMemberArchived,
      handle: async () => {},
      log,
      onFailure,
    });

    await nats.jsm.consumers.delete(STREAMS.members.name, durable); // `nats consumer rm` in the runbook

    // Usually instant: the server tells the open pull request "consumer deleted".
    // If no pull request is open at that moment, the client only notices at its
    // next heartbeat check, ~30 s later ("consumer not found"). Both must fire.
    await eventually(() => expect(onFailure).toHaveBeenCalledOnce(), 60_000);
  }, 70_000);
});
