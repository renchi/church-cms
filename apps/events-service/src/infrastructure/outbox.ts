// The outbox, events-service side (ADR-0010).
//
// toOutboxMessage translates OUR domain event into the published contract in
// @cms/events. The domain never sees the wire format: dates become ISO
// strings, and the message gets its own id, separate from the attendance id.
import { randomUUID } from "crypto";
import { SUBJECTS, type AttendanceRecordedV1, type OutboxBatch, type OutboxRow, type OutboxStore } from "@cms/events";
import type { AttendanceRecordedEvent } from "../domain/events.js";
import type { Db, PrismaClient } from "./prisma.js";

export interface OutboxMessage {
  id: string;
  subject: string;
  payload: AttendanceRecordedV1;
}

// Only AttendanceRecorded crosses the boundary today. EventCreated,
// VolunteerDeclined and the rest stay internal until another context needs
// them; adding one is a new type in @cms/events plus a mapping here.
export function toOutboxMessage(event: AttendanceRecordedEvent): OutboxMessage {
  const id = randomUUID();
  return {
    id,
    subject: SUBJECTS.attendanceRecorded,
    payload: {
      id,
      type: "AttendanceRecorded",
      version: 1,
      occurredAt: event.occurredAt.toISOString(),
      data: {
        attendanceId: event.attendanceId,
        eventId: event.eventId,
        memberId: event.memberId,
        checkedInAt: event.checkedInAt.toISOString(),
      },
    },
  };
}

// Any number: a name for "the outbox relay" lock. Each service has its own
// database, so both services can use the same one without meeting.
const RELAY_LOCK_KEY = 2_202_210;

// What the outbox relay (from @cms/events) reads and updates. Every Pod runs a
// relay; runExclusive lets only one of them run a batch at a time.
export class PrismaOutboxStore implements OutboxStore {
  constructor(private readonly prisma: PrismaClient) {}

  runExclusive<T>(work: (batch: OutboxBatch) => Promise<T>): Promise<T | null> {
    return this.prisma.$transaction(
      async (tx) => {
        // An ADVISORY lock: Postgres locks a number we choose, not a row or a
        // table. The "try" version returns false instead of waiting, and the
        // "xact" version releases it when this transaction ends, even if the
        // Pod crashes (Postgres drops the connection and the transaction).
        const [{ locked }] = await tx.$queryRaw<{ locked: boolean }[]>`
          SELECT pg_try_advisory_xact_lock(${RELAY_LOCK_KEY}) AS locked`;
        if (!locked) return null; // another Pod's relay is running a batch
        return work(new PrismaOutboxBatch(tx));
      },
      // Publishing waits on NATS. When NATS is down, one publish can take ~5 s
      // to time out, so allow more than Prisma's 5 s default.
      { timeout: 30_000 }
    );
  }
}

class PrismaOutboxBatch implements OutboxBatch {
  constructor(private readonly db: Db) {}

  async fetchPending(limit: number): Promise<OutboxRow[]> {
    const rows = await this.db.outboxMessage.findMany({
      where: { publishedAt: null },
      orderBy: { createdAt: "asc" },
      take: limit,
    });
    return rows.map((r) => ({ id: r.id, subject: r.subject, payload: r.payload }));
  }

  async markPublished(id: string, publishedAt: Date): Promise<void> {
    await this.db.outboxMessage.update({ where: { id }, data: { publishedAt } });
  }
}
