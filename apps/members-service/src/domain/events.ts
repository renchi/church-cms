// Domain events: facts about something that already happened in this context,
// named in the past tense. The aggregates RETURN them and never publish. The
// ones other contexts consume, MemberArchived (→ Events) and MemberRegistered
// (→ Communications, CMS-20), are saved to the outbox with the member and
// published to NATS by the outbox relay (ADR-0010). Their WIRE shapes are
// separate types in @cms/events (MemberArchivedV1, MemberRegisteredV1), mapped
// in infrastructure/outbox.ts. MemberUpdated stays internal.
export interface MemberRegisteredEvent {
  type: "MemberRegistered";
  memberId: string;
  occurredAt: Date;
}

export interface MemberUpdatedEvent {
  type: "MemberUpdated";
  memberId: string;
  occurredAt: Date;
}

export interface MemberArchivedEvent {
  type: "MemberArchived";
  memberId: string;
  occurredAt: Date;
}

export type MemberDomainEvent = MemberRegisteredEvent | MemberUpdatedEvent | MemberArchivedEvent;
