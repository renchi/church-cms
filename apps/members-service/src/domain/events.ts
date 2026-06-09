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
