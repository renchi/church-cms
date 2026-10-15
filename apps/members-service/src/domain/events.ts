// Domain events: facts about something that already happened in this context,
// named in the past tense. The aggregates RETURN them and never publish. The
// one another context consumes, MemberArchived (→ Events), is saved to the
// outbox with the member and published to NATS by the outbox relay (ADR-0010).
// Its WIRE shape is a separate type in @cms/events (MemberArchivedV1), mapped
// in infrastructure/outbox.ts.
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
