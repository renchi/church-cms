import { Attendance, type CheckInMethod } from "../domain/Attendance.js";
import { ConflictError, NotFoundError } from "../domain/errors.js";
import type { AttendanceRepository } from "../domain/AttendanceRepository.js";
import type { ServiceEventRepository } from "../domain/ServiceEventRepository.js";

export interface RecordAttendanceInput {
  // A Member's id from the Members context. We store it, but we don't check
  // here that the member exists: that would mean calling members-service on
  // every check-in. It's a known gap, recorded in docs/events-service-ddd.md.
  memberId: string;
  method: CheckInMethod;
  checkedInById?: string;
}

export class RecordAttendanceUseCase {
  constructor(
    private readonly events: ServiceEventRepository,
    private readonly attendances: AttendanceRepository
  ) {}

  async execute(eventId: string, input: RecordAttendanceInput): Promise<{ id: string }> {
    const event = await this.events.findById(eventId);
    if (!event) throw new NotFoundError("Event not found");

    // ADR-0004: one Attendance per member per event. Checking first gives a
    // clear 409; the database's unique constraint catches the race where two
    // check-ins for the same member arrive at the same moment.
    const existing = await this.attendances.findByEventAndMember(eventId, input.memberId.trim());
    if (existing) throw new ConflictError("Member is already checked in to this event");

    const { attendance } = Attendance.record({ event, ...input });
    await this.attendances.save(attendance);
    return { id: attendance.id };
  }
}
