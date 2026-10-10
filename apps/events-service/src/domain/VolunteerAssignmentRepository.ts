import type { VolunteerAssignment, VolunteerRole } from "./VolunteerAssignment.js";

export interface VolunteerAssignmentRepository {
  findByEventMemberAndRole(
    eventId: string,
    memberId: string,
    role: VolunteerRole
  ): Promise<VolunteerAssignment | null>;
  findByEventId(eventId: string): Promise<VolunteerAssignment[]>;
  // Throws ConflictError if the member already holds this role (unique constraint).
  save(assignment: VolunteerAssignment): Promise<void>;
}
