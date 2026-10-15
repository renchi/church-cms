import type { Attendance } from "./Attendance.js";
import type { AttendanceRecordedEvent } from "./events.js";

export interface AttendanceRepository {
  findByEventAndMember(eventId: string, memberId: string): Promise<Attendance | null>;
  // Throws ConflictError if the member is already checked in (unique constraint).
  // `events` are saved with the attendance in one transaction (the
  // transactional outbox, ADR-0010); the relay then publishes them to NATS.
  save(attendance: Attendance, events?: AttendanceRecordedEvent[]): Promise<void>;
}
