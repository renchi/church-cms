import { describe, expect, it, vi } from "vitest";
import { DomainError, NotFoundError } from "../domain/errors.js";
import { VolunteerAssignment } from "../domain/VolunteerAssignment.js";
import { CancelEventUseCase } from "./CancelEventUseCase.js";
import { ADMIN, MEMBER, makeEventRepo, makeVolunteerRepo, upcomingEvent } from "./testFixtures.js";

describe("CancelEventUseCase", () => {
  it("cancels the event and declines every volunteer assignment (ADR-0004)", async () => {
    const event = upcomingEvent();
    const usher = VolunteerAssignment.assign({
      event,
      memberId: MEMBER,
      role: "usher",
      assignedById: ADMIN,
    }).assignment;
    const greeter = VolunteerAssignment.assign({
      event,
      memberId: ADMIN,
      role: "greeter",
      assignedById: ADMIN,
    }).assignment;
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

  it("saves the event last, so a failure part-way leaves it retryable", async () => {
    const event = upcomingEvent();
    const usher = VolunteerAssignment.assign({
      event,
      memberId: MEMBER,
      role: "usher",
      assignedById: ADMIN,
    }).assignment;
    const events = makeEventRepo({ findById: vi.fn().mockResolvedValue(event) });
    const volunteers = makeVolunteerRepo({
      findByEventId: vi.fn().mockResolvedValue([usher]),
      save: vi.fn().mockRejectedValue(new Error("database down")),
    });

    await expect(
      new CancelEventUseCase(events, volunteers).execute(event.id, { reason: "Storm warning" })
    ).rejects.toThrow("database down");
    expect(events.save).not.toHaveBeenCalled();
  });

  it("skips assignments that are already declined", async () => {
    const event = upcomingEvent();
    const declined = VolunteerAssignment.assign({
      event,
      memberId: MEMBER,
      role: "usher",
      assignedById: ADMIN,
    }).assignment;
    declined.decline();
    const events = makeEventRepo({ findById: vi.fn().mockResolvedValue(event) });
    const volunteers = makeVolunteerRepo({ findByEventId: vi.fn().mockResolvedValue([declined]) });

    await new CancelEventUseCase(events, volunteers).execute(event.id, { reason: "Storm warning" });

    expect(volunteers.save).not.toHaveBeenCalled();
  });

  it("writes nothing when the event can't be cancelled", async () => {
    const event = upcomingEvent();
    event.cancel("first time");
    const events = makeEventRepo({ findById: vi.fn().mockResolvedValue(event) });
    const volunteers = makeVolunteerRepo();

    await expect(
      new CancelEventUseCase(events, volunteers).execute(event.id, { reason: "again" })
    ).rejects.toThrow(DomainError);
    expect(volunteers.findByEventId).not.toHaveBeenCalled();
    expect(events.save).not.toHaveBeenCalled();
  });

  it("throws NotFoundError for an unknown event", async () => {
    await expect(
      new CancelEventUseCase(makeEventRepo(), makeVolunteerRepo()).execute("missing", {
        reason: "x",
      })
    ).rejects.toThrow(NotFoundError);
  });
});
