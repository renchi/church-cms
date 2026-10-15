import { NotFoundError } from "../domain/errors.js";
import type { MemberRepository } from "../domain/MemberRepository.js";

export class ArchiveMemberUseCase {
  constructor(private readonly repo: MemberRepository) {}

  async execute(id: string): Promise<void> {
    const member = await this.repo.findById(id);
    if (!member) throw new NotFoundError("Member not found");
    const event = member.archive();
    // Saved with the member, in one transaction. The outbox relay then
    // publishes it, and the Events context declines the member's future
    // volunteer assignments (ADR-0004, ADR-0010).
    await this.repo.save(member, [event]);
  }
}
