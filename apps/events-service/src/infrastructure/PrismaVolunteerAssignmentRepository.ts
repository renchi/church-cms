import type { PrismaClient, VolunteerAssignmentRow } from "./prisma.js";
import {
  VolunteerAssignment,
  type AssignmentStatus,
  type VolunteerRole,
} from "../domain/VolunteerAssignment.js";
import type { VolunteerAssignmentRepository } from "../domain/VolunteerAssignmentRepository.js";
import { prisma as defaultPrisma } from "./prisma.js";
import { rethrowUniqueViolation } from "./uniqueViolation.js";

function toAssignment(row: VolunteerAssignmentRow): VolunteerAssignment {
  return VolunteerAssignment.reconstitute({
    ...row,
    role: row.role as VolunteerRole,
    status: row.status as AssignmentStatus,
  });
}

export class PrismaVolunteerAssignmentRepository implements VolunteerAssignmentRepository {
  constructor(private readonly prisma: PrismaClient = defaultPrisma) {}

  async findByEventMemberAndRole(
    eventId: string,
    memberId: string,
    role: VolunteerRole
  ): Promise<VolunteerAssignment | null> {
    const row = await this.prisma.volunteerAssignment.findUnique({
      where: { eventId_memberId_role: { eventId, memberId, role } },
    });
    return row ? toAssignment(row) : null;
  }

  async findByEventId(eventId: string): Promise<VolunteerAssignment[]> {
    const rows = await this.prisma.volunteerAssignment.findMany({ where: { eventId } });
    return rows.map(toAssignment);
  }

  async save(assignment: VolunteerAssignment): Promise<void> {
    const snap = assignment.toSnapshot();
    await rethrowUniqueViolation(
      this.prisma.volunteerAssignment.upsert({
        where: { id: snap.id },
        create: snap,
        update: { status: snap.status, confirmedAt: snap.confirmedAt },
      }),
      "Member already holds this role for this event"
    );
  }
}
