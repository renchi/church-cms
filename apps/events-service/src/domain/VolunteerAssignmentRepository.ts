import type { VolunteerAssignment, VolunteerRole } from "./VolunteerAssignment.js";

export interface VolunteerAssignmentRepository {
  findByEventMemberAndRole(
    eventId: string,
    memberId: string,
    role: VolunteerRole
  ): Promise<VolunteerAssignment | null>;
  findByEventId(eventId: string): Promise<VolunteerAssignment[]>;
  // Assignments a member still holds (pending or confirmed) on events that
  // are scheduled and haven't started by `now`. Used when the member is
  // archived (ADR-0004). Past events are left alone: that's history.
  findActiveForMemberOnFutureEvents(memberId: string, now: Date): Promise<VolunteerAssignment[]>;
  // Throws ConflictError if the member already holds this role (unique constraint).
  save(assignment: VolunteerAssignment): Promise<void>;
}
