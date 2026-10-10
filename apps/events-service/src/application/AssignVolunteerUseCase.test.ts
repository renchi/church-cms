import { describe, expect, it, vi } from "vitest";
import { ConflictError, NotFoundError } from "../domain/errors.js";
import { VolunteerAssignment } from "../domain/VolunteerAssignment.js";
import { AssignVolunteerUseCase } from "./AssignVolunteerUseCase.js";
import { ADMIN, MEMBER, makeEventRepo, makeVolunteerRepo, upcomingEvent } from "./testFixtures.js";

describe("AssignVolunteerUseCase", () => {
  it("assigns the volunteer and returns the assignment id", async () => {
    const event = upcomingEvent();
    const events = makeEventRepo({ findById: vi.fn().mockResolvedValue(event) });
    const volunteers = makeVolunteerRepo();

    const result = await new AssignVolunteerUseCase(events, volunteers).execute(event.id, {
      memberId: MEMBER,
      role: "worship_team",
      assignedById: ADMIN,
    });

    expect(result.id).toBeTruthy();
    expect(volunteers.save).toHaveBeenCalledOnce();
  });

  it("throws ConflictError when the member already holds the role", async () => {
    const event = upcomingEvent();
    const existing = VolunteerAssignment.assign({
      event,
      memberId: MEMBER,
      role: "usher",
      assignedById: ADMIN,
    }).assignment;
    const events = makeEventRepo({ findById: vi.fn().mockResolvedValue(event) });
    const volunteers = makeVolunteerRepo({
      findByEventMemberAndRole: vi.fn().mockResolvedValue(existing),
    });

    await expect(
      new AssignVolunteerUseCase(events, volunteers).execute(event.id, {
        memberId: MEMBER,
        role: "usher",
        assignedById: ADMIN,
      })
    ).rejects.toThrow(ConflictError);
    expect(volunteers.save).not.toHaveBeenCalled();
  });

  it("throws NotFoundError for an unknown event", async () => {
    await expect(
      new AssignVolunteerUseCase(makeEventRepo(), makeVolunteerRepo()).execute("missing", {
        memberId: MEMBER,
        role: "usher",
        assignedById: ADMIN,
      })
    ).rejects.toThrow(NotFoundError);
  });
});
