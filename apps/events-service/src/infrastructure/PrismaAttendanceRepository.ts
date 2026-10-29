import { captureTraceContext } from "@cms/events";
import { inTransaction, type Db, type Prisma } from "./prisma.js";
import { Attendance, type CheckInMethod } from "../domain/Attendance.js";
import type { AttendanceRepository } from "../domain/AttendanceRepository.js";
import type { AttendanceRecordedEvent } from "../domain/events.js";
import { toOutboxMessage } from "./outbox.js";
import { prisma as defaultPrisma } from "./prisma.js";
import { rethrowUniqueViolation } from "./uniqueViolation.js";

export class PrismaAttendanceRepository implements AttendanceRepository {
  constructor(private readonly db: Db = defaultPrisma) {}

  async findByEventAndMember(eventId: string, memberId: string): Promise<Attendance | null> {
    // `eventId_memberId` is the name Prisma gives the @@unique([eventId, memberId]) index.
    const row = await this.db.attendance.findUnique({
      where: { eventId_memberId: { eventId, memberId } },
    });
    return row ? Attendance.reconstitute({ ...row, method: row.method as CheckInMethod }) : null;
  }

  // An Attendance never changes once recorded, so this is a plain insert.
  // The transactional outbox (ADR-0010): the attendance and its outbox row are
  // written in ONE transaction. If the insert hits the unique constraint (a
  // duplicate check-in), the whole transaction rolls back, outbox row included,
  // so Members never counts a check-in that didn't happen.
  async save(attendance: Attendance, events: AttendanceRecordedEvent[] = []): Promise<void> {
    const messages = events.map(toOutboxMessage);
    await rethrowUniqueViolation(
      inTransaction(this.db, async (tx) => {
        await tx.attendance.create({ data: attendance.toSnapshot() });
        if (messages.length > 0) {
          // The trace context of the request saving this aggregate, so the relay
          // can continue the trace later (CMS-29, @cms/events tracing.ts). One
          // value for every row: they're all written by the same request.
          const traceparent = captureTraceContext();
          await tx.outboxMessage.createMany({
            data: messages.map((m) => ({
              id: m.id,
              subject: m.subject,
              payload: m.payload as unknown as Prisma.InputJsonValue,
              traceparent,
            })),
          });
        }
      }),
      "Member is already checked in to this event"
    );
  }
}
