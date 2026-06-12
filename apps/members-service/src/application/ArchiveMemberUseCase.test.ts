import { describe, expect, it, vi } from "vitest";
import { Member } from "../domain/Member.js";
import type { MemberRepository } from "../domain/MemberRepository.js";
import { DomainError, NotFoundError } from "../domain/errors.js";
import { ArchiveMemberUseCase } from "./ArchiveMemberUseCase.js";

function makeRepo(overrides?: Partial<MemberRepository>): MemberRepository {
  return {
    findById: vi.fn().mockResolvedValue(null),
    findByEmail: vi.fn().mockResolvedValue(null),
    list: vi.fn().mockResolvedValue({ members: [], total: 0 }),
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("ArchiveMemberUseCase", () => {
  it("archives the member and persists the change", async () => {
    const { member } = Member.register({ name: "Alice", email: "alice@example.com" });
    const repo = makeRepo({ findById: vi.fn().mockResolvedValue(member) });
    const useCase = new ArchiveMemberUseCase(repo);

    await useCase.execute(member.id);

    expect(member.status).toBe("archived");
    expect(repo.save).toHaveBeenCalledWith(member);
  });

  it("throws NotFoundError when the member does not exist", async () => {
    const repo = makeRepo();
    const useCase = new ArchiveMemberUseCase(repo);

    await expect(useCase.execute("missing-id")).rejects.toThrow(NotFoundError);
    expect(repo.save).not.toHaveBeenCalled();
  });

  it("does not persist when the member is already archived", async () => {
    const { member } = Member.register({ name: "Alice", email: "alice@example.com" });
    member.archive();
    const repo = makeRepo({ findById: vi.fn().mockResolvedValue(member) });
    const useCase = new ArchiveMemberUseCase(repo);

    await expect(useCase.execute(member.id)).rejects.toThrow(DomainError);
    expect(repo.save).not.toHaveBeenCalled();
  });
});
