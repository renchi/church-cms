import type { PrismaClient } from "./prisma.js";
import { Attendance, type CheckInMethod } from "../domain/Attendance.js";
import type { AttendanceRepository } from "../domain/AttendanceRepository.js";
import { prisma as defaultPrisma } from "./prisma.js";
import { rethrowUniqueViolation } from "./uniqueViolation.js";

export class PrismaAttendanceRepository implements AttendanceRepository {
  constructor(private readonly prisma: PrismaClient = defaultPrisma) {}

  async findByEventAndMember(eventId: string, memberId: string): Promise<Attendance | null> {
    // `eventId_memberId` is the name Prisma gives the @@unique([eventId, memberId]) index.
    const row = await this.prisma.attendance.findUnique({
      where: { eventId_memberId: { eventId, memberId } },
    });
    return row ? Attendance.reconstitute({ ...row, method: row.method as CheckInMethod }) : null;
  }

  // An Attendance never changes once recorded, so this is a plain insert.
  async save(attendance: Attendance): Promise<void> {
    await rethrowUniqueViolation(
      this.prisma.attendance.create({ data: attendance.toSnapshot() }),
      "Member is already checked in to this event"
    );
  }
}
