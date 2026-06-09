import type { Member } from "./Member.js";

export interface MemberRepository {
  findById(id: string): Promise<Member | null>;
  findByEmail(email: string): Promise<Member | null>;
  list(params: { skip: number; take: number }): Promise<{ members: Member[]; total: number }>;
  save(member: Member): Promise<void>;
}
