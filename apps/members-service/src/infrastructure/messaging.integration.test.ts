// Messaging integration tests (ADR-0010): a real Postgres AND a real NATS,
// both throwaway containers (Testcontainers). They check the guarantees the
// design relies on, end to end:
//   - archiving a member writes its outbox row in the same transaction
//   - the relay publishes that row to the MEMBERS stream
//   - an AttendanceRecorded message updates the member's summary exactly once,
//     even when it's delivered twice or two deliveries race
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connectNats, jetStreamPublisher, startOutboxRelay, STREAMS, SUBJECTS, type AttendanceRecordedV1, type NatsHandles } from "@cms/events";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ArchiveMemberUseCase } from "../application/ArchiveMemberUseCase.js";
import { RecordAttendanceInSummaryUseCase } from "../application/RecordAttendanceInSummaryUseCase.js";
import { ConflictError } from "../domain/errors.js";
import { Member } from "../domain/Member.js";
import type { MemberRepository } from "../domain/MemberRepository.js";
import { startMessaging, type Messaging } from "./messaging.js";
import { PrismaOutboxStore } from "./outbox.js";
import { PrismaMemberRepository } from "./PrismaMemberRepository.js";
import { PrismaClient } from "./prisma.js";
import { PrismaUnitOfWork } from "./PrismaUnitOfWork.js";

const serviceDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

// Polls until `check` passes: the relay and consumer work asynchronously.
async function eventually(check: () => Promise<void>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await check();
      return;
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

function attendanceMessage(id: string, memberId: string, checkedInAt: string): AttendanceRecordedV1 {
  return {
    id,
    type: "AttendanceRecorded",
    version: 1,
    occurredAt: checkedInAt,
    data: { attendanceId: `att-${id}`, eventId: "event-1", memberId, checkedInAt },
  };
}

describe("Messaging (integration)", () => {
  let pg: StartedPostgreSqlContainer;
  let natsContainer: StartedTestContainer;
  let prisma: PrismaClient;
  let natsUrl: string;
  let repo: PrismaMemberRepository;

  beforeAll(async () => {
    [pg, natsContainer] = await Promise.all([
      new PostgreSqlContainer("postgres:16-alpine").start(),
      new GenericContainer("nats:2.15.0-alpine")
        .withCommand(["-js"])
        .withExposedPorts(4222)
        .withWaitStrategy(Wait.forLogMessage(/Server is ready/))
        .start(),
    ]);
    const databaseUrl = pg.getConnectionUri().replace("localhost", "127.0.0.1");
    execFileSync("npx", ["--no-install", "prisma", "migrate", "deploy"], {
      cwd: serviceDir,
      stdio: "inherit",
      env: { ...process.env, DATABASE_URL: databaseUrl },
    });
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    repo = new PrismaMemberRepository(prisma);
    natsUrl = `nats://${natsContainer.getHost()}:${natsContainer.getMappedPort(4222)}`;
  }, 180_000);

  afterEach(async () => {
    await prisma.outboxMessage.deleteMany();
    await prisma.processedMessage.deleteMany();
    await prisma.member.deleteMany();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await Promise.all([pg?.stop(), natsContainer?.stop()]);
  });

  describe("transactional outbox", () => {
    it("archiving a member writes exactly one MemberArchived outbox row", async () => {
      const { member } = Member.register({ name: "Alice", email: "alice@example.com" });
      await repo.save(member);

      await new ArchiveMemberUseCase(repo).execute(member.id);

      const rows = await prisma.outboxMessage.findMany();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        subject: "cms.members.archived",
        publishedAt: null,
        payload: { id: rows[0].id, type: "MemberArchived", version: 1, data: { memberId: member.id } },
      });
    });

    it("two relays at once (two Pods): each row is published exactly once, in order", async () => {
      for (let i = 0; i < 20; i++) {
        const { member } = Member.register({ name: `M${i}`, email: `m${i}@example.com` });
        await repo.save(member);
        await new ArchiveMemberUseCase(repo).execute(member.id);
      }
      const published: string[] = [];
      // A slow publish keeps relay A's lock held while relay B tries.
      const publish = async (_subject: string, _payload: unknown, msgId: string) => {
        await new Promise((r) => setTimeout(r, 5));
        published.push(msgId);
      };
      const relay = () =>
        startOutboxRelay({ store: new PrismaOutboxStore(prisma), publish, log, autoStart: false, batchSize: 50 });
      const [a, b] = [relay(), relay()];

      const counts = await Promise.all([a.runOnce(), b.runOnce()]);

      expect(counts.sort()).toEqual([0, 20]); // one relay got the lock, the other skipped
      const expectedOrder = (await prisma.outboxMessage.findMany({ orderBy: { createdAt: "asc" } })).map((r) => r.id);
      expect(published).toEqual(expectedOrder);
    });

    it("writes no outbox row for events no other context consumes", async () => {
      const { member, event } = Member.register({ name: "Alice", email: "alice@example.com" });
      await repo.save(member, [event]); // MemberRegistered: not in the contract

      expect(await prisma.outboxMessage.count()).toBe(0);
    });
  });

  describe("PrismaUnitOfWork.runOnce", () => {
    it("runs the work for a new message id and skips it for a seen one", async () => {
      const uow = new PrismaUnitOfWork(prisma);
      const work = vi.fn().mockResolvedValue(undefined);

      expect(await uow.runOnce("msg-1", work)).toBe(true);
      expect(await uow.runOnce("msg-1", work)).toBe(false);
      expect(work).toHaveBeenCalledOnce();
    });

    it("lets exactly one of two racing deliveries do the work", async () => {
      const { member } = Member.register({ name: "Alice", email: "alice@example.com" });
      await repo.save(member);
      const uow = new PrismaUnitOfWork(prisma);
      const work = async (members: MemberRepository) => {
        const m = await members.findById(member.id);
        m!.recordAttendance(new Date());
        await members.save(m!);
      };

      const results = await Promise.all([uow.runOnce("msg-race", work), uow.runOnce("msg-race", work)]);

      expect(results.sort()).toEqual([false, true]);
      expect((await prisma.member.findUniqueOrThrow({ where: { id: member.id } })).attendanceCount).toBe(1);
    });

    it("rolls back the processed id when the work fails, so a redelivery can retry", async () => {
      const uow = new PrismaUnitOfWork(prisma);

      await expect(uow.runOnce("msg-fail", () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");

      expect(await prisma.processedMessage.count()).toBe(0);
      expect(await uow.runOnce("msg-fail", () => Promise.resolve())).toBe(true);
    });
  });

  describe("optimistic locking (concurrent writers to one member)", () => {
    it("two different attendances for one member at once: one conflicts, its retry counts it", async () => {
      // The code-review scenario: two consumer Pods each take a different
      // AttendanceRecorded for the same member, and both read count 0.
      const { member } = Member.register({ name: "Alice", email: "alice@example.com" });
      await repo.save(member);
      const useCase = new RecordAttendanceInSummaryUseCase(new PrismaUnitOfWork(prisma));
      const input = (messageId: string) => ({ messageId, memberId: member.id, checkedInAt: new Date() });

      const results = await Promise.allSettled([useCase.execute(input("msg-a")), useCase.execute(input("msg-b"))]);

      const rejected = results.filter((r) => r.status === "rejected");
      // Postgres may serialise the two transactions so neither conflicts; if
      // one did, it must be a ConflictError, and its processed id rolled back.
      for (const r of rejected) expect((r as PromiseRejectedResult).reason).toBeInstanceOf(ConflictError);
      // What the consumer does on a conflict: nak, and JetStream redelivers.
      if (rejected.length > 0) await useCase.execute(input(results[0].status === "rejected" ? "msg-a" : "msg-b"));

      const row = await prisma.member.findUniqueOrThrow({ where: { id: member.id } });
      expect(row.attendanceCount).toBe(2); // neither attendance lost
      expect(await prisma.processedMessage.count()).toBe(2);
    });

    it("a stale save can't undo a newer change: the archive survives the consumer's write", async () => {
      const { member } = Member.register({ name: "Alice", email: "alice@example.com" });
      await repo.save(member);
      const consumerCopy = (await repo.findById(member.id))!; // the consumer loads the member...
      await new ArchiveMemberUseCase(repo).execute(member.id); // ...an HTTP archive commits meanwhile

      consumerCopy.recordAttendance(new Date());
      await expect(repo.save(consumerCopy)).rejects.toThrow(ConflictError);

      const row = await prisma.member.findUniqueOrThrow({ where: { id: member.id } });
      expect(row.status).toBe("archived");
    });

    it("a member saved before the version column existed can still be updated", async () => {
      // Rows from before migration 20261015130000 got DEFAULT 1, the same as a
      // freshly saved member, so they're treated as saved, not as new.
      await prisma.$executeRaw`INSERT INTO "Member" (id, name, email, "updatedAt") VALUES ('old-1', 'Old', 'old@example.com', now())`;
      const old = (await repo.findById("old-1"))!;
      expect(old.version).toBe(1);

      old.recordAttendance(new Date());
      await repo.save(old);

      expect((await prisma.member.findUniqueOrThrow({ where: { id: "old-1" } })).attendanceCount).toBe(1);
    });
  });

  describe("over NATS", () => {
    let messaging: Messaging;
    let nats: NatsHandles;

    beforeAll(async () => {
      messaging = await startMessaging({
        natsUrl,
        prisma,
        log,
        // A consumer dying mid-test surfaces as an unhandled error, failing the run.
        onFailure: (err) => {
          throw err;
        },
      });
      nats = await connectNats(natsUrl, "test-client"); // plays the Events context
    });

    afterAll(async () => {
      await messaging?.stop();
      await nats?.nc.drain();
    });

    it("the relay publishes an archived member to the MEMBERS stream", async () => {
      const { member } = Member.register({ name: "Alice", email: "alice@example.com" });
      await repo.save(member);
      await new ArchiveMemberUseCase(repo).execute(member.id);

      await eventually(async () => {
        const row = await prisma.outboxMessage.findFirstOrThrow();
        expect(row.publishedAt).not.toBeNull();
      });
      const stored = await nats.jsm.streams.getMessage(STREAMS.members.name, {
        last_by_subj: SUBJECTS.memberArchived,
      });
      expect(stored?.json()).toMatchObject({ type: "MemberArchived", data: { memberId: member.id } });
    });

    it("an AttendanceRecorded message updates the summary once, even if delivered twice", async () => {
      const { member } = Member.register({ name: "Alice", email: "alice@example.com" });
      await repo.save(member);
      const publish = jetStreamPublisher(nats.js);
      const msg = attendanceMessage("att-msg-1", member.id, "2026-10-11T09:00:00.000Z");

      // Two different Nats-Msg-Ids, so JetStream stores both: the consumer's
      // ProcessedMessage table is what must catch the duplicate.
      await publish(SUBJECTS.attendanceRecorded, msg, "nats-id-a");
      await publish(SUBJECTS.attendanceRecorded, msg, "nats-id-b");

      await eventually(async () => {
        expect(await prisma.processedMessage.count()).toBe(1);
        const row = await prisma.member.findUniqueOrThrow({ where: { id: member.id } });
        expect(row.attendanceCount).toBe(1);
        expect(row.lastAttendedAt?.toISOString()).toBe("2026-10-11T09:00:00.000Z");
      });
      // Give the second delivery time to arrive, then check it changed nothing.
      await new Promise((r) => setTimeout(r, 500));
      const row = await prisma.member.findUniqueOrThrow({ where: { id: member.id } });
      expect(row.attendanceCount).toBe(1);
    });
  });
});
