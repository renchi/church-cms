// Messaging integration tests (ADR-0010): a real Postgres AND a real NATS,
// both throwaway containers (Testcontainers). The events-service half of the
// guarantees:
//   - a check-in writes its outbox row in the same transaction, and a
//     rejected duplicate check-in writes none
//   - the "future assignments" query leaves past, cancelled and declined ones alone
//   - a MemberArchived message declines the member's future assignments once,
//     even when it's delivered twice
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connectNats, jetStreamPublisher, STREAMS, SUBJECTS, type MemberArchivedV1, type NatsHandles } from "@cms/events";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { RecordAttendanceUseCase } from "../application/RecordAttendanceUseCase.js";
import { ConflictError } from "../domain/errors.js";
import { startMessaging, type Messaging } from "./messaging.js";
import { PrismaAttendanceRepository } from "./PrismaAttendanceRepository.js";
import { PrismaClient } from "./prisma.js";
import { PrismaServiceEventRepository } from "./PrismaServiceEventRepository.js";
import { PrismaVolunteerAssignmentRepository } from "./PrismaVolunteerAssignmentRepository.js";

const serviceDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const MEMBER = "22222222-2222-4222-8222-222222222222";
const OTHER_MEMBER = "44444444-4444-4444-8444-444444444444";
const ADMIN = "33333333-3333-4333-8333-333333333333";
const inHours = (h: number) => new Date(Date.now() + h * 60 * 60 * 1000);

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

describe("Messaging (integration)", () => {
  let pg: StartedPostgreSqlContainer;
  let natsContainer: StartedTestContainer;
  let prisma: PrismaClient;
  let natsUrl: string;

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
    natsUrl = `nats://${natsContainer.getHost()}:${natsContainer.getMappedPort(4222)}`;
  }, 180_000);

  afterEach(async () => {
    await prisma.outboxMessage.deleteMany();
    await prisma.processedMessage.deleteMany();
    await prisma.attendance.deleteMany();
    await prisma.volunteerAssignment.deleteMany();
    await prisma.serviceEvent.deleteMany();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await Promise.all([pg?.stop(), natsContainer?.stop()]);
  });

  // Rows are inserted directly so a test can set up states the domain would
  // refuse to create today, like an event in the past.
  async function insertEvent(scheduledAt: Date, status = "scheduled"): Promise<string> {
    const id = crypto.randomUUID();
    await prisma.serviceEvent.create({
      data: {
        id,
        title: "Sunday Morning Service",
        eventType: "service",
        venueName: "Main Sanctuary",
        scheduledAt,
        durationMinutes: 90,
        status,
        createdById: ADMIN,
      },
    });
    return id;
  }

  async function insertAssignment(eventId: string, memberId = MEMBER, status = "pending", role = "usher") {
    const id = crypto.randomUUID();
    await prisma.volunteerAssignment.create({
      data: { id, eventId, memberId, role, status, assignedById: ADMIN, assignedAt: new Date() },
    });
    return id;
  }

  describe("transactional outbox", () => {
    it("a check-in writes one AttendanceRecorded outbox row; a rejected duplicate writes none", async () => {
      const eventId = await insertEvent(inHours(1));
      const useCase = new RecordAttendanceUseCase(
        new PrismaServiceEventRepository(prisma),
        new PrismaAttendanceRepository(prisma)
      );

      const { id: attendanceId } = await useCase.execute(eventId, { memberId: MEMBER, method: "self" });
      // Skip the use case's friendly pre-check to hit the unique constraint
      // inside the transaction: the outbox insert must roll back with it.
      const repo = new PrismaAttendanceRepository(prisma);
      const existing = (await repo.findByEventAndMember(eventId, MEMBER))!;
      await expect(repo.save(existing, [])).rejects.toThrow(ConflictError);

      const rows = await prisma.outboxMessage.findMany();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        subject: "cms.events.attendance.recorded",
        payload: { type: "AttendanceRecorded", data: { attendanceId, eventId, memberId: MEMBER } },
      });
    });
  });

  describe("findActiveForMemberOnFutureEvents", () => {
    it("returns only the member's pending or confirmed assignments on future, scheduled events", async () => {
      const future = await insertEvent(inHours(24));
      const past = await insertEvent(inHours(-24));
      const cancelled = await insertEvent(inHours(24), "cancelled");
      const wanted = [
        await insertAssignment(future, MEMBER, "pending", "usher"),
        await insertAssignment(future, MEMBER, "confirmed", "greeter"),
      ];
      await insertAssignment(future, MEMBER, "declined", "media_tech");
      await insertAssignment(future, OTHER_MEMBER);
      await insertAssignment(past);
      await insertAssignment(cancelled);

      const found = await new PrismaVolunteerAssignmentRepository(prisma).findActiveForMemberOnFutureEvents(
        MEMBER,
        new Date()
      );

      expect(found.map((a) => a.id).sort()).toEqual(wanted.sort());
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
      nats = await connectNats(natsUrl, "test-client"); // plays the Members context
    });

    afterAll(async () => {
      await messaging?.stop();
      await nats?.nc.drain();
    });

    it("the relay publishes a check-in to the EVENTS stream", async () => {
      const eventId = await insertEvent(inHours(1));
      await new RecordAttendanceUseCase(
        new PrismaServiceEventRepository(prisma),
        new PrismaAttendanceRepository(prisma)
      ).execute(eventId, { memberId: MEMBER, method: "self" });

      await eventually(async () => {
        expect((await prisma.outboxMessage.findFirstOrThrow()).publishedAt).not.toBeNull();
      });
      const stored = await nats.jsm.streams.getMessage(STREAMS.events.name, {
        last_by_subj: SUBJECTS.attendanceRecorded,
      });
      expect(stored?.json()).toMatchObject({ type: "AttendanceRecorded", data: { eventId, memberId: MEMBER } });
    });

    it("a MemberArchived message declines future assignments once, even if delivered twice", async () => {
      const future = await insertEvent(inHours(24));
      const past = await insertEvent(inHours(-24));
      const futureAssignment = await insertAssignment(future);
      const pastAssignment = await insertAssignment(past);
      const msg: MemberArchivedV1 = {
        id: crypto.randomUUID(),
        type: "MemberArchived",
        version: 1,
        occurredAt: new Date().toISOString(),
        data: { memberId: MEMBER },
      };
      const publish = jetStreamPublisher(nats.js);

      // Two different Nats-Msg-Ids, so JetStream stores both; ProcessedMessage
      // is what must catch the duplicate.
      await publish(SUBJECTS.memberArchived, msg, "nats-id-a");
      await publish(SUBJECTS.memberArchived, msg, "nats-id-b");

      await eventually(async () => {
        const row = await prisma.volunteerAssignment.findUniqueOrThrow({ where: { id: futureAssignment } });
        expect(row.status).toBe("declined");
      });
      await new Promise((r) => setTimeout(r, 500)); // let the second delivery land
      expect(await prisma.processedMessage.count()).toBe(1);
      const untouched = await prisma.volunteerAssignment.findUniqueOrThrow({ where: { id: pastAssignment } });
      expect(untouched.status).toBe("pending"); // history is left alone
    });
  });
});
