import { describe, expect, it, vi } from "vitest";
import { Member } from "../domain/Member.js";
import type { MemberRepository } from "../domain/MemberRepository.js";
import { DomainError, NotFoundError } from "../domain/errors.js";
import { UpdateMemberUseCase } from "./UpdateMemberUseCase.js";

function makeRepo(overrides?: Partial<MemberRepository>): MemberRepository {
  return {
    findById: vi.fn().mockResolvedValue(null),
    findByEmail: vi.fn().mockResolvedValue(null),
    list: vi.fn().mockResolvedValue({ members: [], total: 0 }),
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("UpdateMemberUseCase", () => {
  it("applies the update and persists the member", async () => {
    const { member } = Member.register({ name: "Alice", email: "alice@example.com" });
    const repo = makeRepo({ findById: vi.fn().mockResolvedValue(member) });
    const useCase = new UpdateMemberUseCase(repo);

    await useCase.execute(member.id, { name: "Alicia" });

    expect(member.name).toBe("Alicia");
    expect(repo.save).toHaveBeenCalledWith(member);
  });

  it("throws NotFoundError when the member does not exist", async () => {
    const repo = makeRepo();
    const useCase = new UpdateMemberUseCase(repo);

    await expect(useCase.execute("missing-id", { name: "Alicia" })).rejects.toThrow(NotFoundError);
    expect(repo.save).not.toHaveBeenCalled();
  });

  it("does not persist when the domain rejects the update", async () => {
    const { member } = Member.register({ name: "Alice", email: "alice@example.com" });
    const repo = makeRepo({ findById: vi.fn().mockResolvedValue(member) });
    const useCase = new UpdateMemberUseCase(repo);

    await expect(useCase.execute(member.id, { name: "   " })).rejects.toThrow(DomainError);
    expect(repo.save).not.toHaveBeenCalled();
  });
});
