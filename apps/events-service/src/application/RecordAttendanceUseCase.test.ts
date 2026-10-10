import { describe, expect, it, vi } from "vitest";
import { Attendance } from "../domain/Attendance.js";
import { ConflictError, NotFoundError } from "../domain/errors.js";
import { RecordAttendanceUseCase } from "./RecordAttendanceUseCase.js";
import { MEMBER, makeAttendanceRepo, makeEventRepo, upcomingEvent } from "./testFixtures.js";

describe("RecordAttendanceUseCase", () => {
  it("records attendance and returns its id", async () => {
    const event = upcomingEvent();
    const events = makeEventRepo({ findById: vi.fn().mockResolvedValue(event) });
    const attendances = makeAttendanceRepo();

    const result = await new RecordAttendanceUseCase(events, attendances).execute(event.id, {
      memberId: MEMBER,
      method: "self",
    });

    expect(result.id).toBeTruthy();
    expect(attendances.save).toHaveBeenCalledOnce();
  });

  it("throws ConflictError when the member is already checked in", async () => {
    const event = upcomingEvent();
    const existing = Attendance.record({ event, memberId: MEMBER, method: "self" }).attendance;
    const events = makeEventRepo({ findById: vi.fn().mockResolvedValue(event) });
    const attendances = makeAttendanceRepo({
      findByEventAndMember: vi.fn().mockResolvedValue(existing),
    });

    await expect(
      new RecordAttendanceUseCase(events, attendances).execute(event.id, {
        memberId: MEMBER,
        method: "self",
      })
    ).rejects.toThrow(ConflictError);
    expect(attendances.save).not.toHaveBeenCalled();
  });

  it("throws NotFoundError for an unknown event", async () => {
    const attendances = makeAttendanceRepo();
    await expect(
      new RecordAttendanceUseCase(makeEventRepo(), attendances).execute("missing", {
        memberId: MEMBER,
        method: "self",
      })
    ).rejects.toThrow(NotFoundError);
    expect(attendances.save).not.toHaveBeenCalled();
  });
});
