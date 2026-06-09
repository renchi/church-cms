import { describe, expect, it, vi } from "vitest";
import { Member } from "../domain/Member.js";
import type { MemberRepository } from "../domain/MemberRepository.js";
import { ConflictError } from "../domain/errors.js";
import { RegisterMemberUseCase } from "./RegisterMemberUseCase.js";

function makeRepo(overrides?: Partial<MemberRepository>): MemberRepository {
  return {
    findById: vi.fn().mockResolvedValue(null),
    findByEmail: vi.fn().mockResolvedValue(null),
    list: vi.fn().mockResolvedValue({ members: [], total: 0 }),
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("RegisterMemberUseCase", () => {
  it("saves a new member and returns its id", async () => {
    const repo = makeRepo();
    const useCase = new RegisterMemberUseCase(repo);

    const result = await useCase.execute({ name: "Alice", email: "alice@example.com" });

    expect(result.id).toBeTruthy();
    expect(repo.save).toHaveBeenCalledOnce();
  });

  it("throws ConflictError when email is already registered", async () => {
    const { member } = Member.register({ name: "Existing", email: "alice@example.com" });
    const repo = makeRepo({ findByEmail: vi.fn().mockResolvedValue(member) });
    const useCase = new RegisterMemberUseCase(repo);

    await expect(useCase.execute({ name: "Alice", email: "alice@example.com" })).rejects.toThrow(
      ConflictError
    );
    expect(repo.save).not.toHaveBeenCalled();
  });

  it("does not save when domain validation fails", async () => {
    const repo = makeRepo();
    const useCase = new RegisterMemberUseCase(repo);

    await expect(useCase.execute({ name: "", email: "alice@example.com" })).rejects.toThrow();
    expect(repo.save).not.toHaveBeenCalled();
  });
});
