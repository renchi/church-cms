import { Member } from "../domain/Member.js";
import { ConflictError } from "../domain/errors.js";
import type { MemberRepository } from "../domain/MemberRepository.js";

export interface RegisterMemberInput {
  name: string;
  email: string;
  phone?: string;
}

export class RegisterMemberUseCase {
  constructor(private readonly repo: MemberRepository) {}

  async execute(input: RegisterMemberInput): Promise<{ id: string }> {
    const existing = await this.repo.findByEmail(input.email.toLowerCase().trim());
    if (existing) throw new ConflictError("Email already registered");

    // The event goes to save() with the member: the repository writes its
    // outbox row in the same transaction (ADR-0010). A use case never publishes.
    const { member, event } = Member.register(input);
    await this.repo.save(member, [event]);
    return { id: member.id };
  }
}
