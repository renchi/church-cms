import { NotFoundError } from "../domain/errors.js";
import type { MemberRepository } from "../domain/MemberRepository.js";

export class ArchiveMemberUseCase {
  constructor(private readonly repo: MemberRepository) {}

  async execute(id: string): Promise<void> {
    const member = await this.repo.findById(id);
    if (!member) throw new NotFoundError("Member not found");
    member.archive();
    await this.repo.save(member);
  }
}
