import { describe, expect, it, vi } from "vitest";
import { Member } from "../domain/Member.js";
import type { MemberRepository } from "../domain/MemberRepository.js";
import { RecordAttendanceInSummaryUseCase } from "./RecordAttendanceInSummaryUseCase.js";
import type { UnitOfWork } from "./UnitOfWork.js";

function makeRepo(overrides?: Partial<MemberRepository>): MemberRepository {
  return {
    findById: vi.fn().mockResolvedValue(null),
    findByEmail: vi.fn().mockResolvedValue(null),
    list: vi.fn().mockResolvedValue({ members: [], total: 0 }),
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// An in-memory UnitOfWork: remembers processed ids the way the
// ProcessedMessage table does.
function makeUnitOfWork(repo: MemberRepository): UnitOfWork {
  const processed = new Set<string>();
  return {
    runOnce: vi.fn(async (messageId, work) => {
      if (processed.has(messageId)) return false;
      processed.add(messageId);
      await work(repo);
      return true;
    }),
  };
}

const checkedInAt = new Date("2026-10-11T09:00:00Z");

describe("RecordAttendanceInSummaryUseCase", () => {
  it("adds the attendance to the member's summary", async () => {
    const { member } = Member.register({ name: "Alice", email: "alice@example.com" });
    const repo = makeRepo({ findById: vi.fn().mockResolvedValue(member) });
    const useCase = new RecordAttendanceInSummaryUseCase(makeUnitOfWork(repo));

    const outcome = await useCase.execute({ messageId: "msg-1", memberId: member.id, checkedInAt });

    expect(outcome).toBe("applied");
    expect(member.attendanceCount).toBe(1);
    expect(member.lastAttendedAt).toEqual(checkedInAt);
    expect(repo.save).toHaveBeenCalledWith(member);
  });

  it("does nothing the second time the same message arrives", async () => {
    const { member } = Member.register({ name: "Alice", email: "alice@example.com" });
    const repo = makeRepo({ findById: vi.fn().mockResolvedValue(member) });
    const useCase = new RecordAttendanceInSummaryUseCase(makeUnitOfWork(repo));

    await useCase.execute({ messageId: "msg-1", memberId: member.id, checkedInAt });
    const outcome = await useCase.execute({ messageId: "msg-1", memberId: member.id, checkedInAt });

    expect(outcome).toBe("duplicate");
    expect(member.attendanceCount).toBe(1);
    expect(repo.save).toHaveBeenCalledOnce();
  });

  it("reports an unknown member without failing, so the message isn't retried forever", async () => {
    const repo = makeRepo();
    const useCase = new RecordAttendanceInSummaryUseCase(makeUnitOfWork(repo));

    const outcome = await useCase.execute({ messageId: "msg-1", memberId: "nobody", checkedInAt });

    expect(outcome).toBe("member-not-found");
    expect(repo.save).not.toHaveBeenCalled();
  });
});
