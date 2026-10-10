import { describe, expect, it } from "vitest";
import { Attendance } from "./Attendance.js";
import { DomainError } from "./errors.js";
import { ServiceEvent } from "./ServiceEvent.js";

const CREATED = new Date("2026-10-10T09:00:00Z");
const STARTS = new Date("2026-10-11T10:00:00Z");
const MEMBER = "22222222-2222-4222-8222-222222222222";
const USHER = "33333333-3333-4333-8333-333333333333";

function sundayService(): ServiceEvent {
  return ServiceEvent.schedule(
    {
      title: "Sunday Morning Service",
      eventType: "service",
      venue: { name: "Main Sanctuary" },
      scheduledAt: STARTS,
      durationMinutes: 90,
      createdById: USHER,
    },
    CREATED
  ).event;
}

const minutesBeforeStart = (m: number) => new Date(STARTS.getTime() - m * 60_000);

describe("Attendance.record", () => {
  it("records a self check-in and emits AttendanceRecorded", () => {
    const event = sundayService();
    const now = minutesBeforeStart(10);
    const { attendance, domainEvent } = Attendance.record(
      { event, memberId: MEMBER, method: "self" },
      now
    );
    expect(attendance.eventId).toBe(event.id);
    expect(attendance.memberId).toBe(MEMBER);
    expect(attendance.checkedInAt).toEqual(now);
    // Self check-in: the member recorded it themselves.
    expect(attendance.toSnapshot().checkedInById).toBe(MEMBER);
    expect(domainEvent).toMatchObject({
      type: "AttendanceRecorded",
      attendanceId: attendance.id,
      eventId: event.id,
      memberId: MEMBER,
      checkedInAt: now,
    });
  });

  it("records a manual check-in by someone else", () => {
    const { attendance } = Attendance.record(
      { event: sundayService(), memberId: MEMBER, method: "manual", checkedInById: USHER },
      minutesBeforeStart(5)
    );
    expect(attendance.toSnapshot().checkedInById).toBe(USHER);
  });

  it("rejects a manual check-in that doesn't say who recorded it", () => {
    expect(() =>
      Attendance.record(
        { event: sundayService(), memberId: MEMBER, method: "manual" },
        minutesBeforeStart(5)
      )
    ).toThrow(/checkedInById/);
  });

  it("allows check-in exactly two hours before the start", () => {
    expect(() =>
      Attendance.record(
        { event: sundayService(), memberId: MEMBER, method: "self" },
        minutesBeforeStart(120)
      )
    ).not.toThrow();
  });

  it("rejects check-in more than two hours before the start", () => {
    expect(() =>
      Attendance.record(
        { event: sundayService(), memberId: MEMBER, method: "self" },
        minutesBeforeStart(121)
      )
    ).toThrow(DomainError);
  });

  it("rejects check-in to a cancelled event", () => {
    const event = sundayService();
    event.cancel("Storm warning", CREATED);
    expect(() =>
      Attendance.record({ event, memberId: MEMBER, method: "self" }, minutesBeforeStart(5))
    ).toThrow(/cancelled/);
  });

  it("rejects a self check-in recorded by someone else", () => {
    expect(() =>
      Attendance.record(
        { event: sundayService(), memberId: MEMBER, method: "self", checkedInById: USHER },
        minutesBeforeStart(5)
      )
    ).toThrow(DomainError);
  });

  it("rejects an empty memberId", () => {
    expect(() =>
      Attendance.record(
        { event: sundayService(), memberId: " ", method: "self" },
        minutesBeforeStart(5)
      )
    ).toThrow(DomainError);
  });
});
