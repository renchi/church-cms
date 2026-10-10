import { describe, expect, it } from "vitest";
import { DomainError } from "./errors.js";
import { ServiceEvent } from "./ServiceEvent.js";
import { VolunteerAssignment } from "./VolunteerAssignment.js";

const NOW = new Date("2026-10-10T09:00:00Z");
const MEMBER = "22222222-2222-4222-8222-222222222222";
const ADMIN = "33333333-3333-4333-8333-333333333333";

function sundayService(): ServiceEvent {
  return ServiceEvent.schedule(
    {
      title: "Sunday Morning Service",
      eventType: "service",
      venue: { name: "Main Sanctuary" },
      scheduledAt: new Date("2026-10-11T10:00:00Z"),
      durationMinutes: 90,
      createdById: ADMIN,
    },
    NOW
  ).event;
}

describe("VolunteerAssignment.assign", () => {
  it("creates a pending assignment and emits VolunteerAssigned", () => {
    const event = sundayService();
    const { assignment, domainEvent } = VolunteerAssignment.assign(
      { event, memberId: MEMBER, role: "usher", assignedById: ADMIN },
      NOW
    );
    expect(assignment.status).toBe("pending");
    expect(assignment.toSnapshot().confirmedAt).toBeNull();
    expect(domainEvent).toMatchObject({
      type: "VolunteerAssigned",
      assignmentId: assignment.id,
      eventId: event.id,
      memberId: MEMBER,
      role: "usher",
    });
  });

  it("rejects assignment to a cancelled event", () => {
    const event = sundayService();
    event.cancel("Storm warning", NOW);
    expect(() =>
      VolunteerAssignment.assign({ event, memberId: MEMBER, role: "usher", assignedById: ADMIN })
    ).toThrow(DomainError);
  });

  it("requires assignedById", () => {
    expect(() =>
      VolunteerAssignment.assign({
        event: sundayService(),
        memberId: MEMBER,
        role: "usher",
        assignedById: "",
      })
    ).toThrow(DomainError);
  });
});

describe("VolunteerAssignment.decline", () => {
  it("moves the assignment to declined and emits VolunteerDeclined", () => {
    const { assignment } = VolunteerAssignment.assign({
      event: sundayService(),
      memberId: MEMBER,
      role: "greeter",
      assignedById: ADMIN,
    });
    const domainEvent = assignment.decline(NOW);
    expect(assignment.status).toBe("declined");
    expect(domainEvent?.type).toBe("VolunteerDeclined");
  });

  it("is a no-op the second time", () => {
    const { assignment } = VolunteerAssignment.assign({
      event: sundayService(),
      memberId: MEMBER,
      role: "greeter",
      assignedById: ADMIN,
    });
    assignment.decline(NOW);
    expect(assignment.decline(NOW)).toBeNull();
  });
});
