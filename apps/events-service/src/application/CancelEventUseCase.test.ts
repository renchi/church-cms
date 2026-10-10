import { describe, expect, it, vi } from "vitest";
import { DomainError, NotFoundError } from "../domain/errors.js";
import { ServiceEvent } from "../domain/ServiceEvent.js";
import { VolunteerAssignment } from "../domain/VolunteerAssignment.js";
import { CancelEventUseCase } from "./CancelEventUseCase.js";
import { ADMIN, MEMBER, makeEventRepo, makeVolunteerRepo, upcomingEvent } from "./testFixtures.js";

function assign(event: ServiceEvent, role: "usher" | "greeter") {
  return VolunteerAssignment.assign({ event, memberId: MEMBER, role, assignedById: ADMIN })
    .assignment;
}

describe("CancelEventUseCase", () => {
  it("cancels the event and declines every volunteer assignment (ADR-0004)", async () => {
    const event = upcomingEvent();
    const usher = assign(event, "usher");
    const greeter = assign(event, "greeter");
    const events = makeEventRepo({ findById: vi.fn().mockResolvedValue(event) });
    const volunteers = makeVolunteerRepo({
      findByEventId: vi.fn().mockResolvedValue([usher, greeter]),
    });

    await new CancelEventUseCase(events, volunteers).execute(event.id, { reason: "Storm warning" });

    expect(event.status).toBe("cancelled");
    expect(usher.status).toBe("declined");
    expect(greeter.status).toBe("declined");
    expect(volunteers.save).toHaveBeenCalledTimes(2);
    expect(events.save).toHaveBeenCalledWith(event);
  });

  it("saves the event BEFORE reading the assignments to sweep", async () => {
    const event = upcomingEvent();
    const order: string[] = [];
    const events = makeEventRepo({
      findById: vi.fn().mockResolvedValue(event),
      save: vi.fn(async () => void order.push("save event")),
    });
    const volunteers = makeVolunteerRepo({
      findByEventId: vi.fn(async () => (order.push("read assignments"), [])),
    });

    await new CancelEventUseCase(events, volunteers).execute(event.id, { reason: "Storm warning" });

    expect(order).toEqual(["save event", "read assignments"]);
  });

  it("is idempotent: cancelling again only re-sweeps, so a failed sweep can be retried", async () => {
    const event = upcomingEvent();
    event.cancel("first time");
    const leftOver = assign(upcomingEvent(), "usher"); // still pending
    const events = makeEventRepo({ findById: vi.fn().mockResolvedValue(event) });
    const volunteers = makeVolunteerRepo({ findByEventId: vi.fn().mockResolvedValue([leftOver]) });

    await new CancelEventUseCase(events, volunteers).execute(event.id, { reason: "again" });

    expect(events.save).not.toHaveBeenCalled();
    expect(leftOver.status).toBe("declined");
    expect(volunteers.save).toHaveBeenCalledOnce();
  });

  it("skips assignments that are already declined", async () => {
    const event = upcomingEvent();
    const declined = assign(event, "usher");
    declined.decline();
    const events = makeEventRepo({ findById: vi.fn().mockResolvedValue(event) });
    const volunteers = makeVolunteerRepo({ findByEventId: vi.fn().mockResolvedValue([declined]) });

    await new CancelEventUseCase(events, volunteers).execute(event.id, { reason: "Storm warning" });

    expect(volunteers.save).not.toHaveBeenCalled();
  });

  it("writes nothing when the domain refuses the transition", async () => {
    const completed = ServiceEvent.reconstitute({
      ...upcomingEvent().toSnapshot(),
      status: "completed",
    });
    const events = makeEventRepo({ findById: vi.fn().mockResolvedValue(completed) });
    const volunteers = makeVolunteerRepo();

    await expect(
      new CancelEventUseCase(events, volunteers).execute(completed.id, { reason: "too late" })
    ).rejects.toThrow(DomainError);
    expect(events.save).not.toHaveBeenCalled();
    expect(volunteers.findByEventId).not.toHaveBeenCalled();
  });

  it("throws NotFoundError for an unknown event", async () => {
    await expect(
      new CancelEventUseCase(makeEventRepo(), makeVolunteerRepo()).execute("missing", {
        reason: "x",
      })
    ).rejects.toThrow(NotFoundError);
  });
});
