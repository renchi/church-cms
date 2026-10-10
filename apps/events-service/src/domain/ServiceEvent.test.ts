import { describe, expect, it } from "vitest";
import { DomainError } from "./errors.js";
import { ServiceEvent, Venue, type ScheduleEventParams } from "./ServiceEvent.js";

// A fixed "now" keeps every time-based rule deterministic.
const NOW = new Date("2026-10-10T09:00:00Z");
const NEXT_SUNDAY = new Date("2026-10-11T10:00:00Z");
const CREATOR = "11111111-1111-4111-8111-111111111111";

function params(overrides: Partial<ScheduleEventParams> = {}): ScheduleEventParams {
  return {
    title: "Sunday Morning Service",
    eventType: "service",
    venue: { name: "Main Sanctuary" },
    scheduledAt: NEXT_SUNDAY,
    durationMinutes: 90,
    createdById: CREATOR,
    ...overrides,
  };
}

describe("ServiceEvent.schedule", () => {
  it("creates a scheduled event with valid inputs", () => {
    const { event } = ServiceEvent.schedule(params(), NOW);
    expect(event.id).toBeTruthy();
    expect(event.status).toBe("scheduled");
    expect(event.title).toBe("Sunday Morning Service");
    expect(event.ministerId).toBeNull();
    expect(event.venue.name).toBe("Main Sanctuary");
    expect(event.venue.isOnline).toBe(false);
  });

  it("emits EventCreated with the ADR-0004 payload", () => {
    const { event, domainEvent } = ServiceEvent.schedule(params(), NOW);
    expect(domainEvent).toMatchObject({
      type: "EventCreated",
      eventId: event.id,
      title: "Sunday Morning Service",
      eventType: "service",
      scheduledAt: NEXT_SUNDAY,
      venue: { name: "Main Sanctuary", address: null, isOnline: false },
    });
  });

  it("trims text and turns blank optionals into null", () => {
    const { event } = ServiceEvent.schedule(
      params({ title: "  Youth Night  ", description: "   ", ministerId: "  " }),
      NOW
    );
    expect(event.title).toBe("Youth Night");
    expect(event.description).toBeNull();
    expect(event.ministerId).toBeNull();
  });

  it("rejects an event scheduled in the past", () => {
    expect(() =>
      ServiceEvent.schedule(params({ scheduledAt: new Date("2026-10-01T10:00:00Z") }), NOW)
    ).toThrow(DomainError);
  });

  it("rejects an event scheduled exactly now", () => {
    expect(() => ServiceEvent.schedule(params({ scheduledAt: NOW }), NOW)).toThrow(DomainError);
  });

  it.each([0, -30, 1.5])("rejects a duration of %s minutes", (durationMinutes) => {
    expect(() => ServiceEvent.schedule(params({ durationMinutes }), NOW)).toThrow(DomainError);
  });

  it("rejects an empty title", () => {
    expect(() => ServiceEvent.schedule(params({ title: "  " }), NOW)).toThrow(DomainError);
  });

  it("rejects an invalid date", () => {
    expect(() => ServiceEvent.schedule(params({ scheduledAt: new Date("nope") }), NOW)).toThrow(
      DomainError
    );
  });

  it("allows an event without a minister (ADR-0004)", () => {
    const { event } = ServiceEvent.schedule(params({ ministerId: null }), NOW);
    expect(event.ministerId).toBeNull();
  });
});

describe("Venue (value object)", () => {
  it("rejects an empty name", () => {
    expect(() => Venue.create({ name: " " })).toThrow(DomainError);
  });

  it("is equal to another venue with the same values", () => {
    const a = Venue.create({ name: "Youth Hall", address: "1 Church St" });
    const b = Venue.create({ name: "Youth Hall", address: "1 Church St" });
    expect(a.equals(b)).toBe(true);
    expect(a.equals(Venue.create({ name: "Youth Hall" }))).toBe(false);
  });
});

describe("ServiceEvent.update", () => {
  it("changes only the fields given", () => {
    const { event } = ServiceEvent.schedule(params(), NOW);
    event.update({ title: "Harvest Service", durationMinutes: 120 }, NOW);
    expect(event.title).toBe("Harvest Service");
    expect(event.durationMinutes).toBe(120);
    expect(event.venue.name).toBe("Main Sanctuary");
  });

  it("applies nothing when one field is invalid", () => {
    const { event } = ServiceEvent.schedule(params(), NOW);
    expect(() => event.update({ title: "New title", durationMinutes: 0 }, NOW)).toThrow(
      DomainError
    );
    expect(event.title).toBe("Sunday Morning Service");
  });

  it("rejects rescheduling into the past", () => {
    const { event } = ServiceEvent.schedule(params(), NOW);
    expect(() => event.update({ scheduledAt: new Date("2020-01-01T00:00:00Z") }, NOW)).toThrow(
      DomainError
    );
    expect(event.scheduledAt).toEqual(NEXT_SUNDAY);
  });

  it("starts at version 0 (never saved)", () => {
    expect(ServiceEvent.schedule(params(), NOW).event.version).toBe(0);
  });

  it("rejects updates to a cancelled event", () => {
    const { event } = ServiceEvent.schedule(params(), NOW);
    event.cancel("Storm warning", NOW);
    expect(() => event.update({ title: "Back on" }, NOW)).toThrow(DomainError);
  });

  it("rejects updates to a completed event", () => {
    const { event } = ServiceEvent.schedule(params(), NOW);
    const completed = ServiceEvent.reconstitute({ ...event.toSnapshot(), status: "completed" });
    expect(() => completed.update({ title: "Again" }, NOW)).toThrow(DomainError);
  });
});

describe("ServiceEvent.cancel", () => {
  it("moves the event to cancelled and emits EventCancelled", () => {
    const { event } = ServiceEvent.schedule(params(), NOW);
    const domainEvent = event.cancel("  Storm warning  ", NOW);
    expect(event.status).toBe("cancelled");
    expect(domainEvent).toMatchObject({
      type: "EventCancelled",
      eventId: event.id,
      cancelledAt: NOW,
      reason: "Storm warning",
    });
  });

  it("cannot be cancelled twice (no way back to scheduled)", () => {
    const { event } = ServiceEvent.schedule(params(), NOW);
    event.cancel("Storm warning", NOW);
    expect(() => event.cancel("Again", NOW)).toThrow(DomainError);
  });

  it("cannot cancel a completed event", () => {
    const { event } = ServiceEvent.schedule(params(), NOW);
    const completed = ServiceEvent.reconstitute({ ...event.toSnapshot(), status: "completed" });
    expect(() => completed.cancel("Too late", NOW)).toThrow(DomainError);
  });

  it("requires a reason", () => {
    const { event } = ServiceEvent.schedule(params(), NOW);
    expect(() => event.cancel("  ", NOW)).toThrow(DomainError);
    expect(event.status).toBe("scheduled");
  });
});

describe("ServiceEvent.reconstitute", () => {
  it("round-trips through a snapshot", () => {
    const { event } = ServiceEvent.schedule(params(), NOW);
    const restored = ServiceEvent.reconstitute(event.toSnapshot());
    expect(restored.toSnapshot()).toEqual(event.toSnapshot());
  });
});
