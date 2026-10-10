import { randomUUID } from "crypto";
import { DomainError } from "./errors.js";
import type { AttendanceRecordedEvent } from "./events.js";
import type { ServiceEvent } from "./ServiceEvent.js";

// "qr_code" is modelled (ADR-0004) but its implementation is deferred, so the
// API only accepts the other two for now.
export type CheckInMethod = "self" | "manual" | "qr_code";
export const AVAILABLE_CHECK_IN_METHODS: readonly CheckInMethod[] = ["self", "manual"];

// ADR-0004: check-in may open at most two hours before the event starts.
export const CHECK_IN_WINDOW_MS = 2 * 60 * 60 * 1000;

export interface AttendanceSnapshot {
  id: string;
  eventId: string;
  memberId: string;
  checkedInAt: Date;
  checkedInById: string;
  method: CheckInMethod;
}

// Why is Attendance its own aggregate instead of a list inside ServiceEvent?
// A Sunday service can have hundreds of attendees. Loading and saving all of
// them to add one check-in would make the event aggregate unbounded, and two
// people checking in at once would conflict on the same aggregate. Each
// Attendance enforces its own rules; the one rule that spans many of them
// (one per member per event) is a uniqueness check in the use case, backed by
// a database constraint. See ADR-0004's decision log.
export class Attendance {
  private constructor(private readonly snap: AttendanceSnapshot) {}

  get id() {
    return this.snap.id;
  }
  get eventId() {
    return this.snap.eventId;
  }
  get memberId() {
    return this.snap.memberId;
  }
  get checkedInAt() {
    return this.snap.checkedInAt;
  }
  get method() {
    return this.snap.method;
  }

  // Takes the ServiceEvent itself (same bounded context, so that's allowed) to
  // check the rules that depend on the event. `memberId` is just a string: the
  // Member lives in another context, and we never load or import it.
  static record(
    params: {
      event: ServiceEvent;
      memberId: string;
      method: CheckInMethod;
      // Who recorded it. For a self check-in that's the member themselves.
      checkedInById?: string;
    },
    now: Date = new Date()
  ): { attendance: Attendance; domainEvent: AttendanceRecordedEvent } {
    const { event } = params;
    const memberId = params.memberId.trim();
    if (!memberId) throw new DomainError("memberId is required");
    if (!event.isOpenForCheckIn()) {
      throw new DomainError(`Cannot check in to an event that is ${event.status}`);
    }
    if (now.getTime() < event.scheduledAt.getTime() - CHECK_IN_WINDOW_MS) {
      throw new DomainError("Check-in opens two hours before the event starts");
    }
    // A self check-in is recorded by the member; anything else must say who
    // recorded it, so the audit trail never credits the member by accident.
    if (params.method !== "self" && !params.checkedInById?.trim()) {
      throw new DomainError("checkedInById is required unless the member checks in themselves");
    }
    const checkedInById = params.checkedInById?.trim() || memberId;
    if (params.method === "self" && checkedInById !== memberId) {
      throw new DomainError("A self check-in must be recorded by the member themselves");
    }

    const attendance = new Attendance({
      id: randomUUID(),
      eventId: event.id,
      memberId,
      checkedInAt: now,
      checkedInById,
      method: params.method,
    });

    return {
      attendance,
      domainEvent: {
        type: "AttendanceRecorded",
        attendanceId: attendance.id,
        eventId: attendance.eventId,
        memberId: attendance.memberId,
        checkedInAt: attendance.checkedInAt,
        occurredAt: now,
      },
    };
  }

  toSnapshot(): AttendanceSnapshot {
    return { ...this.snap };
  }

  static reconstitute(snapshot: AttendanceSnapshot): Attendance {
    return new Attendance({ ...snapshot });
  }
}
