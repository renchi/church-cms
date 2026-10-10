import { ConflictError, NotFoundError } from "../domain/errors.js";
import type { ServiceEventRepository } from "../domain/ServiceEventRepository.js";
import { VolunteerAssignment, type VolunteerRole } from "../domain/VolunteerAssignment.js";
import type { VolunteerAssignmentRepository } from "../domain/VolunteerAssignmentRepository.js";

export interface AssignVolunteerInput {
  memberId: string;
  role: VolunteerRole;
  assignedById: string;
}

export class AssignVolunteerUseCase {
  constructor(
    private readonly events: ServiceEventRepository,
    private readonly volunteers: VolunteerAssignmentRepository
  ) {}

  async execute(eventId: string, input: AssignVolunteerInput): Promise<{ id: string }> {
    const event = await this.events.findById(eventId);
    if (!event) throw new NotFoundError("Event not found");

    // ADR-0004: one assignment per member per role per event. A different
    // role for the same member is fine (e.g. worship_team + usher).
    const existing = await this.volunteers.findByEventMemberAndRole(
      eventId,
      input.memberId.trim(),
      input.role
    );
    if (existing) throw new ConflictError("Member already holds this role for this event");

    const { assignment } = VolunteerAssignment.assign({ event, ...input });
    await this.volunteers.save(assignment);

    // The event may have been cancelled while we were working: our copy was
    // loaded before. If so, CancelEventUseCase's sweep may already have run
    // and missed this assignment, so decline it ourselves. (See the comment
    // in CancelEventUseCase for why this closes the race.)
    const latest = await this.events.findById(eventId);
    if (latest?.status === "cancelled" && assignment.decline()) {
      await this.volunteers.save(assignment);
    }
    return { id: assignment.id };
  }
}
