import type { MemberDomainEvent } from "./events.js";
import type { Member } from "./Member.js";

export interface MemberRepository {
  findById(id: string): Promise<Member | null>;
  findByEmail(email: string): Promise<Member | null>;
  list(params: { skip: number; take: number }): Promise<{ members: Member[]; total: number }>;
  // `events` are the domain events the change produced. The repository saves
  // them together with the member (the transactional outbox, ADR-0010), so a
  // use case never publishes anything itself.
  save(member: Member, events?: MemberDomainEvent[]): Promise<void>;
}
