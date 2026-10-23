import { describe, expect, it } from "vitest";
import { InvalidMessageError, parseAttendanceRecorded, parseMemberArchived, parseMemberRegistered } from "./contract.js";

const archived = {
  id: "msg-1",
  type: "MemberArchived",
  version: 1,
  occurredAt: "2026-10-15T10:00:00.000Z",
  data: { memberId: "m-1" },
};

const registered = {
  id: "msg-3",
  type: "MemberRegistered",
  version: 1,
  occurredAt: "2026-10-23T10:00:00.000Z",
  data: { memberId: "m-2" },
};

const attendance = {
  id: "msg-2",
  type: "AttendanceRecorded",
  version: 1,
  occurredAt: "2026-10-15T10:00:00.000Z",
  data: { attendanceId: "a-1", eventId: "e-1", memberId: "m-1", checkedInAt: "2026-10-15T09:59:00.000Z" },
};

describe("parseMemberArchived", () => {
  it("accepts a valid message", () => {
    expect(parseMemberArchived(archived)).toEqual(archived);
  });

  it("drops fields that aren't part of the contract", () => {
    const parsed = parseMemberArchived({ ...archived, extra: true, data: { memberId: "m-1", name: "Ann" } });
    expect(parsed).toEqual(archived);
  });

  it.each([
    ["not an object", "hello"],
    ["missing id", { ...archived, id: undefined }],
    ["wrong type", { ...archived, type: "MemberRegistered" }],
    ["unknown version", { ...archived, version: 2 }],
    ["bad occurredAt", { ...archived, occurredAt: "yesterday" }],
    ["missing data", { ...archived, data: undefined }],
    ["empty memberId", { ...archived, data: { memberId: "" } }],
  ])("rejects a message with %s", (_label, raw) => {
    expect(() => parseMemberArchived(raw)).toThrow(InvalidMessageError);
  });
});

describe("parseMemberRegistered", () => {
  it("accepts a valid message", () => {
    expect(parseMemberRegistered(registered)).toEqual(registered);
  });

  // The contract can grow: if Members later adds name/email to the payload,
  // a consumer built against today's V1 keeps working. That's what makes
  // adding a field a non-breaking change.
  it("ignores fields added to the payload later", () => {
    const grown = { ...registered, data: { memberId: "m-2", name: "Ann", email: "ann@example.com" } };
    expect(parseMemberRegistered(grown)).toEqual(registered);
  });

  it.each([
    ["missing memberId", { ...registered, data: {} }],
    ["wrong type", { ...registered, type: "MemberArchived" }],
    ["unknown version", { ...registered, version: 2 }],
  ])("rejects a message with %s", (_label, raw) => {
    expect(() => parseMemberRegistered(raw)).toThrow(InvalidMessageError);
  });
});

describe("parseAttendanceRecorded", () => {
  it("accepts a valid message", () => {
    expect(parseAttendanceRecorded(attendance)).toEqual(attendance);
  });

  it("rejects a bad checkedInAt", () => {
    const raw = { ...attendance, data: { ...attendance.data, checkedInAt: "soon" } };
    expect(() => parseAttendanceRecorded(raw)).toThrow(InvalidMessageError);
  });

  it("rejects a missing eventId", () => {
    const raw = { ...attendance, data: { ...attendance.data, eventId: undefined } };
    expect(() => parseAttendanceRecorded(raw)).toThrow(InvalidMessageError);
  });
});
