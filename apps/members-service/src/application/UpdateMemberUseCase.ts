import { NotFoundError } from "../domain/errors.js";
import type { MemberRepository } from "../domain/MemberRepository.js";

export interface UpdateMemberInput {
  name?: string;
  phone?: string | null;
}

export class UpdateMemberUseCase {
  constructor(private readonly repo: MemberRepository) {}

  async execute(id: string, input: UpdateMemberInput): Promise<void> {
    const member = await this.repo.findById(id);
    if (!member) throw new NotFoundError("Member not found");
    member.update(input);
    await this.repo.save(member);
  }
}
