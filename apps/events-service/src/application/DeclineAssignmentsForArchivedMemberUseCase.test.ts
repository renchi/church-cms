import { describe, expect, it, vi } from "vitest";
import { VolunteerAssignment } from "../domain/VolunteerAssignment.js";
import type { VolunteerAssignmentRepository } from "../domain/VolunteerAssignmentRepository.js";
import { DeclineAssignmentsForArchivedMemberUseCase } from "./DeclineAssignmentsForArchivedMemberUseCase.js";
import { ADMIN, MEMBER, makeVolunteerRepo, upcomingEvent } from "./testFixtures.js";
import type { UnitOfWork } from "./UnitOfWork.js";

// An in-memory UnitOfWork that remembers processed ids, like the
// ProcessedMessage table.
function makeUnitOfWork(volunteerAssignments: VolunteerAssignmentRepository): UnitOfWork {
  const processed = new Set<string>();
  return {
    runOnce: vi.fn(async (messageId, work) => {
      if (processed.has(messageId)) return false;
      processed.add(messageId);
      await work({ volunteerAssignments });
      return true;
    }),
  };
}

function assignment(role: "usher" | "worship_team") {
  return VolunteerAssignment.assign({ event: upcomingEvent(), memberId: MEMBER, role, assignedById: ADMIN })
    .assignment;
}

describe("DeclineAssignmentsForArchivedMemberUseCase", () => {
  it("declines every active assignment the member holds on future events", async () => {
    const assignments = [assignment("usher"), assignment("worship_team")];
    const repo = makeVolunteerRepo({
      findActiveForMemberOnFutureEvents: vi.fn().mockResolvedValue(assignments),
    });
    const useCase = new DeclineAssignmentsForArchivedMemberUseCase(makeUnitOfWork(repo));

    const result = await useCase.execute({ messageId: "msg-1", memberId: MEMBER });

    expect(result).toEqual({ outcome: "applied", declined: 2 });
    expect(assignments.map((a) => a.status)).toEqual(["declined", "declined"]);
    expect(repo.save).toHaveBeenCalledTimes(2);
    expect(repo.findActiveForMemberOnFutureEvents).toHaveBeenCalledWith(MEMBER, expect.any(Date));
  });

  it("does nothing the second time the same message arrives", async () => {
    const repo = makeVolunteerRepo({
      findActiveForMemberOnFutureEvents: vi.fn().mockResolvedValue([assignment("usher")]),
    });
    const useCase = new DeclineAssignmentsForArchivedMemberUseCase(makeUnitOfWork(repo));

    await useCase.execute({ messageId: "msg-1", memberId: MEMBER });
    const result = await useCase.execute({ messageId: "msg-1", memberId: MEMBER });

    expect(result).toEqual({ outcome: "duplicate", declined: 0 });
    expect(repo.save).toHaveBeenCalledOnce();
  });

  it("succeeds with nothing to decline when the member has no assignments", async () => {
    const repo = makeVolunteerRepo();
    const useCase = new DeclineAssignmentsForArchivedMemberUseCase(makeUnitOfWork(repo));

    expect(await useCase.execute({ messageId: "msg-1", memberId: MEMBER })).toEqual({
      outcome: "applied",
      declined: 0,
    });
  });
});
