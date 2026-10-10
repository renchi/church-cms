import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { ConflictError } from "../domain/errors.js";
import { PrismaAttendanceRepository } from "../infrastructure/PrismaAttendanceRepository.js";
import { PrismaClient } from "../infrastructure/prisma.js";
import { PrismaServiceEventRepository } from "../infrastructure/PrismaServiceEventRepository.js";
import { PrismaVolunteerAssignmentRepository } from "../infrastructure/PrismaVolunteerAssignmentRepository.js";

// Integration tests: real HTTP -> use case -> Prisma -> Postgres, against a
// throwaway database (Testcontainers), the same setup as members-service.
// They need Docker running.

const serviceDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const MEMBER = "22222222-2222-4222-8222-222222222222";
const ADMIN = "33333333-3333-4333-8333-333333333333";
const inHours = (h: number) => new Date(Date.now() + h * 60 * 60 * 1000).toISOString();

describe("Events API (integration)", () => {
  let container: StartedPostgreSqlContainer;
  let prisma: PrismaClient;
  let app: FastifyInstance;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    // Force IPv4 (see the members-service integration test for why).
    const databaseUrl = container.getConnectionUri().replace("localhost", "127.0.0.1");

    execFileSync("npx", ["--no-install", "prisma", "migrate", "deploy"], {
      cwd: serviceDir,
      stdio: "inherit",
      env: { ...process.env, DATABASE_URL: databaseUrl },
    });

    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    app = buildApp({
      events: new PrismaServiceEventRepository(prisma),
      attendances: new PrismaAttendanceRepository(prisma),
      volunteers: new PrismaVolunteerAssignmentRepository(prisma),
    });
    await app.ready();
  }, 180_000);

  afterEach(async () => {
    // Children first: the foreign keys point at ServiceEvent.
    await prisma.attendance.deleteMany();
    await prisma.volunteerAssignment.deleteMany();
    await prisma.serviceEvent.deleteMany();
  });

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
    await container?.stop();
  });

  async function createEvent(overrides: Record<string, unknown> = {}): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/events",
      payload: {
        title: "Sunday Morning Service",
        eventType: "service",
        venue: { name: "Main Sanctuary", address: "1 Church St" },
        scheduledAt: inHours(1),
        durationMinutes: 90,
        createdById: ADMIN,
        ...overrides,
      },
    });
    expect(res.statusCode).toBe(201);
    return res.json<{ id: string }>().id;
  }

  describe("POST /events", () => {
    it("stores the event, with the Venue value object flattened into columns", async () => {
      const id = await createEvent();
      const row = await prisma.serviceEvent.findUnique({ where: { id } });
      expect(row).toMatchObject({
        title: "Sunday Morning Service",
        status: "scheduled",
        venueName: "Main Sanctuary",
        venueAddress: "1 Church St",
        venueIsOnline: false,
      });
    });

    it("returns 400 for an event in the past (a domain rule)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/events",
        payload: {
          title: "Too late",
          eventType: "event",
          venue: { name: "Youth Hall" },
          scheduledAt: inHours(-1),
          durationMinutes: 60,
          createdById: ADMIN,
        },
      });
      expect(res.statusCode).toBe(400);
      expect(await prisma.serviceEvent.count()).toBe(0);
    });

    it("returns 400 for a malformed body (a schema rule)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/events",
        payload: { title: "No venue", eventType: "concert" },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("GET /events", () => {
    it("lists upcoming events soonest first, without cancelled ones", async () => {
      const later = await createEvent({ title: "Later", scheduledAt: inHours(48) });
      const sooner = await createEvent({ title: "Sooner", scheduledAt: inHours(24) });
      const cancelled = await createEvent({ title: "Cancelled", scheduledAt: inHours(12) });
      await app.inject({
        method: "POST",
        url: `/events/${cancelled}/cancel`,
        payload: { reason: "Storm warning" },
      });

      const res = await app.inject({ method: "GET", url: "/events" });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ data: { id: string }[]; meta: { total: number } }>();
      expect(body.data.map((e) => e.id)).toEqual([sooner, later]);
      expect(body.meta.total).toBe(2);
    });
  });

  describe("GET and PUT /events/:id", () => {
    it("updates an event and returns the new state", async () => {
      const id = await createEvent();

      const put = await app.inject({
        method: "PUT",
        url: `/events/${id}`,
        payload: { title: "Harvest Service", venue: { name: "Online", isOnline: true } },
      });
      expect(put.statusCode).toBe(204);

      const get = await app.inject({ method: "GET", url: `/events/${id}` });
      expect(get.statusCode).toBe(200);
      expect(get.json()).toMatchObject({
        title: "Harvest Service",
        venue: { name: "Online", address: null, isOnline: true },
      });
    });

    it("returns 404 for an unknown event", async () => {
      const res = await app.inject({ method: "GET", url: "/events/does-not-exist" });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("POST /events/:id/attendance", () => {
    it("records attendance against a memberId, with no Member data copied", async () => {
      const eventId = await createEvent();

      const res = await app.inject({
        method: "POST",
        url: `/events/${eventId}/attendance`,
        payload: { memberId: MEMBER },
      });

      expect(res.statusCode).toBe(201);
      const row = await prisma.attendance.findUnique({ where: { id: res.json().id } });
      expect(row).toMatchObject({ eventId, memberId: MEMBER, method: "self" });
    });

    it("returns 409 when the member checks in twice", async () => {
      const eventId = await createEvent();
      const checkIn = () =>
        app.inject({
          method: "POST",
          url: `/events/${eventId}/attendance`,
          payload: { memberId: MEMBER },
        });

      expect((await checkIn()).statusCode).toBe(201);
      expect((await checkIn()).statusCode).toBe(409);
      expect(await prisma.attendance.count()).toBe(1);
    });

    it("lets the database's unique constraint decide a race between two check-ins", async () => {
      const eventId = await createEvent();
      const checkIn = () =>
        app.inject({
          method: "POST",
          url: `/events/${eventId}/attendance`,
          payload: { memberId: MEMBER },
        });

      // Sent together, both may pass the "already checked in?" read before
      // either has written. The unique constraint makes sure only one INSERT
      // wins, and the loser gets a 409, not a 500.
      const codes = (await Promise.all([checkIn(), checkIn()])).map((r) => r.statusCode).sort();

      expect(codes).toEqual([201, 409]);
      expect(await prisma.attendance.count()).toBe(1);
    });

    it("returns 400 when check-in isn't open yet", async () => {
      const eventId = await createEvent({ scheduledAt: inHours(5) });
      const res = await app.inject({
        method: "POST",
        url: `/events/${eventId}/attendance`,
        payload: { memberId: MEMBER },
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 400 for a memberId that isn't a UUID", async () => {
      const eventId = await createEvent();
      const res = await app.inject({
        method: "POST",
        url: `/events/${eventId}/attendance`,
        payload: { memberId: "alice" },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("volunteers and cancellation", () => {
    it("assigns volunteers, rejects a duplicate role, and declines them all on cancel", async () => {
      const eventId = await createEvent();
      const assign = (role: string) =>
        app.inject({
          method: "POST",
          url: `/events/${eventId}/volunteers`,
          payload: { memberId: MEMBER, role, assignedById: ADMIN },
        });

      expect((await assign("worship_team")).statusCode).toBe(201);
      expect((await assign("usher")).statusCode).toBe(201); // a second role is fine
      expect((await assign("usher")).statusCode).toBe(409); // the same role twice is not

      const cancel = await app.inject({
        method: "POST",
        url: `/events/${eventId}/cancel`,
        payload: { reason: "Storm warning" },
      });
      expect(cancel.statusCode).toBe(204);

      const statuses = await prisma.volunteerAssignment.findMany({ select: { status: true } });
      expect(statuses).toEqual([{ status: "declined" }, { status: "declined" }]);

      // A cancelled event accepts no check-ins and stays cancelled.
      const checkIn = await app.inject({
        method: "POST",
        url: `/events/${eventId}/attendance`,
        payload: { memberId: MEMBER },
      });
      expect(checkIn.statusCode).toBe(400);
      const update = await app.inject({
        method: "PUT",
        url: `/events/${eventId}`,
        payload: { title: "Back on" },
      });
      expect(update.statusCode).toBe(400);
      // Cancelling again is allowed and changes nothing (idempotent, so a
      // half-finished cancel can be retried; see CancelEventUseCase).
      const again = await app.inject({
        method: "POST",
        url: `/events/${eventId}/cancel`,
        payload: { reason: "Again" },
      });
      expect(again.statusCode).toBe(204);
      const row = await prisma.serviceEvent.findUnique({ where: { id: eventId } });
      expect(row?.status).toBe("cancelled");
    });
  });

  describe("optimistic locking", () => {
    it("can edit a row written before the version column existed", async () => {
      // The previous release doesn't know about `version`, so its INSERTs leave
      // it to the column default. Those rows must load as "already saved".
      await prisma.$executeRaw`
        INSERT INTO "ServiceEvent" (id, title, "eventType", "venueName", "scheduledAt",
          "durationMinutes", "createdById", "updatedAt")
        VALUES ('old-release-event', 'Old', 'service', 'Main Sanctuary',
          now() + interval '1 day', 60, ${ADMIN}, now())`;

      const res = await app.inject({
        method: "PUT",
        url: "/events/old-release-event",
        payload: { title: "Edited" },
      });

      expect(res.statusCode).toBe(204);
      const row = await prisma.serviceEvent.findUnique({ where: { id: "old-release-event" } });
      expect(row).toMatchObject({ title: "Edited", version: 2 });
    });

    it("rejects a save based on a stale copy instead of overwriting the newer change", async () => {
      const id = await createEvent();
      const repo = new PrismaServiceEventRepository(prisma);

      // Two requests load the same event (version 1)...
      const editor = await repo.findById(id);
      const canceller = await repo.findById(id);

      // ...one cancels it and saves first (version 1 → 2)...
      canceller!.cancel("Storm warning");
      await repo.save(canceller!);

      // ...then the other saves its edit, made on the version-1 copy. Without
      // the version check this would write status "scheduled" back.
      editor!.update({ title: "Harvest Service" });
      await expect(repo.save(editor!)).rejects.toThrow(ConflictError);

      const row = await prisma.serviceEvent.findUnique({ where: { id } });
      expect(row).toMatchObject({
        status: "cancelled",
        title: "Sunday Morning Service",
        version: 2,
      });
    });
  });
});
