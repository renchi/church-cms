import { describe, expect, it } from "vitest";
import { Member } from "./Member.js";
import { DomainError } from "./errors.js";

describe("Member.register", () => {
  it("creates an active member with valid inputs", () => {
    const { member } = Member.register({ name: "Alice", email: "alice@example.com" });
    expect(member.name).toBe("Alice");
    expect(member.email).toBe("alice@example.com");
    expect(member.status).toBe("active");
    expect(member.phone).toBeNull();
    expect(member.id).toBeTruthy();
  });

  it("trims whitespace and lowercases email", () => {
    const { member } = Member.register({ name: "  Bob  ", email: "  BOB@EXAMPLE.COM  " });
    expect(member.name).toBe("Bob");
    expect(member.email).toBe("bob@example.com");
  });

  it("treats a blank phone as no phone", () => {
    // A form's empty phone field arrives as "" or "  ". That means "no phone", not a phone of "".
    const { member } = Member.register({ name: "Alice", email: "alice@example.com", phone: "  " });
    expect(member.phone).toBeNull();
  });

  it("stores phone when provided", () => {
    const { member } = Member.register({
      name: "Alice",
      email: "alice@example.com",
      phone: "+1234567890",
    });
    expect(member.phone).toBe("+1234567890");
  });

  it("emits a MemberRegistered event", () => {
    const { event } = Member.register({ name: "Alice", email: "alice@example.com" });
    expect(event.type).toBe("MemberRegistered");
    expect(event.memberId).toBeTruthy();
  });

  it("throws DomainError for empty name", () => {
    expect(() => Member.register({ name: "   ", email: "x@x.com" })).toThrow(DomainError);
  });

  it("throws DomainError for invalid email", () => {
    expect(() => Member.register({ name: "Alice", email: "not-an-email" })).toThrow(DomainError);
  });
});

describe("Member.archive", () => {
  it("sets status to archived", () => {
    const { member } = Member.register({ name: "Alice", email: "alice@example.com" });
    member.archive();
    expect(member.status).toBe("archived");
  });

  it("throws DomainError when already archived", () => {
    const { member } = Member.register({ name: "Alice", email: "alice@example.com" });
    member.archive();
    expect(() => member.archive()).toThrow(DomainError);
  });
});

describe("Member.update", () => {
  it("updates name", () => {
    const { member } = Member.register({ name: "Alice", email: "alice@example.com" });
    member.update({ name: "Alicia" });
    expect(member.name).toBe("Alicia");
  });

  it("clears phone when null is passed", () => {
    const { member } = Member.register({ name: "Alice", email: "alice@example.com", phone: "123" });
    member.update({ phone: null });
    expect(member.phone).toBeNull();
  });

  it("clears phone when a blank phone is passed", () => {
    const { member } = Member.register({ name: "Alice", email: "alice@example.com", phone: "123" });
    member.update({ phone: "" });
    expect(member.phone).toBeNull();
  });

  it("throws DomainError for empty name", () => {
    const { member } = Member.register({ name: "Alice", email: "alice@example.com" });
    expect(() => member.update({ name: "  " })).toThrow(DomainError);
  });

  it("throws DomainError when updating an archived member", () => {
    const { member } = Member.register({ name: "Alice", email: "alice@example.com" });
    member.archive();
    expect(() => member.update({ name: "Alicia" })).toThrow(DomainError);
  });
});

describe("Member.recordAttendance", () => {
  const sunday = new Date("2026-10-11T09:00:00Z");
  const nextSunday = new Date("2026-10-18T09:00:00Z");

  it("starts a new member with an empty summary", () => {
    const { member } = Member.register({ name: "Alice", email: "alice@example.com" });
    expect(member.attendanceCount).toBe(0);
    expect(member.lastAttendedAt).toBeNull();
  });

  it("counts each attendance and remembers the date", () => {
    const { member } = Member.register({ name: "Alice", email: "alice@example.com" });
    member.recordAttendance(sunday);
    member.recordAttendance(nextSunday);
    expect(member.attendanceCount).toBe(2);
    expect(member.lastAttendedAt).toEqual(nextSunday);
  });

  it("keeps the latest date when attendances arrive out of order", () => {
    // Messages can arrive late (a consumer was down, a retry), so the summary
    // must not move backwards in time.
    const { member } = Member.register({ name: "Alice", email: "alice@example.com" });
    member.recordAttendance(nextSunday);
    member.recordAttendance(sunday);
    expect(member.attendanceCount).toBe(2);
    expect(member.lastAttendedAt).toEqual(nextSunday);
  });

  it("still counts attendance for an archived member", () => {
    // The check-in happened before the archive message reached Events; it's a fact.
    const { member } = Member.register({ name: "Alice", email: "alice@example.com" });
    member.archive();
    member.recordAttendance(sunday);
    expect(member.attendanceCount).toBe(1);
  });
});

describe("Member.reconstitute", () => {
  it("round-trips through snapshot", () => {
    const { member } = Member.register({ name: "Alice", email: "alice@example.com" });
    const restored = Member.reconstitute(member.toSnapshot());
    expect(restored.id).toBe(member.id);
    expect(restored.email).toBe(member.email);
    expect(restored.status).toBe("active");
  });
});
