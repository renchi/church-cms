import type { Attendance } from "./Attendance.js";

export interface AttendanceRepository {
  findByEventAndMember(eventId: string, memberId: string): Promise<Attendance | null>;
  // Throws ConflictError if the member is already checked in (unique constraint).
  save(attendance: Attendance): Promise<void>;
}
