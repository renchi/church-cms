import { describe, expect, it } from "vitest";
import { DomainError } from "../domain/errors.js";
import { ScheduleEventUseCase } from "./ScheduleEventUseCase.js";
import { ADMIN, makeEventRepo } from "./testFixtures.js";

const input = {
  title: "Youth Camp 2026",
  eventType: "event" as const,
  venue: { name: "Camp Grounds", address: "Lakeside Rd" },
  scheduledAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  durationMinutes: 240,
  createdById: ADMIN,
};

describe("ScheduleEventUseCase", () => {
  it("saves a new event and returns its id", async () => {
    const repo = makeEventRepo();
    const result = await new ScheduleEventUseCase(repo).execute(input);
    expect(result.id).toBeTruthy();
    expect(repo.save).toHaveBeenCalledOnce();
  });

  it("does not save when the domain rejects the event", async () => {
    const repo = makeEventRepo();
    await expect(
      new ScheduleEventUseCase(repo).execute({ ...input, scheduledAt: new Date(Date.now() - 1000) })
    ).rejects.toThrow(DomainError);
    expect(repo.save).not.toHaveBeenCalled();
  });
});
