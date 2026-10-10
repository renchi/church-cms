import { randomUUID } from "crypto";
import { DomainError } from "./errors.js";
import type { VolunteerAssignedEvent, VolunteerDeclinedEvent } from "./events.js";
import type { ServiceEvent } from "./ServiceEvent.js";

export type VolunteerRole =
  | "worship_team"
  | "usher"
  | "media_tech"
  | "greeter"
  | "intercessor"
  | "children_ministry"
  | "other";
export const VOLUNTEER_ROLES: readonly VolunteerRole[] = [
  "worship_team",
  "usher",
  "media_tech",
  "greeter",
  "intercessor",
  "children_ministry",
  "other",
];

export type AssignmentStatus = "pending" | "confirmed" | "declined";

export interface VolunteerAssignmentSnapshot {
  id: string;
  eventId: string;
  memberId: string;
  role: VolunteerRole;
  assignedById: string;
  assignedAt: Date;
  confirmedAt: Date | null;
  status: AssignmentStatus;
}

// A separate aggregate for the same reason as Attendance (ADR-0004): one event
// can have many volunteers, and no rule needs all of them loaded at once.
export class VolunteerAssignment {
  private constructor(private snap: VolunteerAssignmentSnapshot) {}

  get id() {
    return this.snap.id;
  }
  get eventId() {
    return this.snap.eventId;
  }
  get memberId() {
    return this.snap.memberId;
  }
  get role() {
    return this.snap.role;
  }
  get status() {
    return this.snap.status;
  }

  static assign(
    params: { event: ServiceEvent; memberId: string; role: VolunteerRole; assignedById: string },
    now: Date = new Date()
  ): { assignment: VolunteerAssignment; domainEvent: VolunteerAssignedEvent } {
    const memberId = params.memberId.trim();
    if (!memberId) throw new DomainError("memberId is required");
    if (!params.assignedById.trim()) throw new DomainError("assignedById is required");
    if (!params.event.acceptsVolunteers()) {
      throw new DomainError(`Cannot assign volunteers to an event that is ${params.event.status}`);
    }

    // A new assignment starts "pending": the volunteer hasn't confirmed yet.
    const assignment = new VolunteerAssignment({
      id: randomUUID(),
      eventId: params.event.id,
      memberId,
      role: params.role,
      assignedById: params.assignedById.trim(),
      assignedAt: now,
      confirmedAt: null,
      status: "pending",
    });

    return {
      assignment,
      domainEvent: {
        type: "VolunteerAssigned",
        assignmentId: assignment.id,
        eventId: assignment.eventId,
        memberId: assignment.memberId,
        role: assignment.role,
        occurredAt: now,
      },
    };
  }

  // Used when the event is cancelled (ADR-0004: "assignments to a cancelled
  // event are automatically moved to declined"). Declining twice is a no-op
  // rather than an error, so cancelling can be retried safely.
  decline(now: Date = new Date()): VolunteerDeclinedEvent | null {
    if (this.snap.status === "declined") return null;
    this.snap.status = "declined";
    return {
      type: "VolunteerDeclined",
      assignmentId: this.id,
      eventId: this.eventId,
      memberId: this.memberId,
      occurredAt: now,
    };
  }

  toSnapshot(): VolunteerAssignmentSnapshot {
    return { ...this.snap };
  }

  static reconstitute(snapshot: VolunteerAssignmentSnapshot): VolunteerAssignment {
    return new VolunteerAssignment({ ...snapshot });
  }
}
