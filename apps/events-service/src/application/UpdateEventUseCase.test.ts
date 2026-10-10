import { describe, expect, it, vi } from "vitest";
import { NotFoundError } from "../domain/errors.js";
import { UpdateEventUseCase } from "./UpdateEventUseCase.js";
import { makeEventRepo, upcomingEvent } from "./testFixtures.js";

describe("UpdateEventUseCase", () => {
  it("updates and saves the event", async () => {
    const event = upcomingEvent();
    const repo = makeEventRepo({ findById: vi.fn().mockResolvedValue(event) });
    await new UpdateEventUseCase(repo).execute(event.id, { title: "Harvest Service" });
    expect(event.title).toBe("Harvest Service");
    expect(repo.save).toHaveBeenCalledWith(event);
  });

  it("throws NotFoundError for an unknown event", async () => {
    const repo = makeEventRepo();
    await expect(new UpdateEventUseCase(repo).execute("missing", { title: "x" })).rejects.toThrow(
      NotFoundError
    );
    expect(repo.save).not.toHaveBeenCalled();
  });
});
