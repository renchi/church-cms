// A business rule was broken, e.g. a welcome email without a member.
export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomainError";
  }
}

// Members couldn't answer right now (it's down, restarting, or slow). Nothing is
// wrong with the message itself: asking again later will work. The consumer
// answers NATS with `nak` (redeliver later) for any error that isn't an
// InvalidMessageError (packages/events/src/consumer.ts).
export class RecipientsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecipientsUnavailableError";
  }
}

// Members answered, and doesn't know this member. Members never deletes anyone (it
// archives), so for an id taken from a real MemberRegistered this means something
// is broken: the wrong Members URL, a database restored to an older state, a
// hand-written message. Asking again can't make the member appear, so the
// consumer gives up on the message (`term`) and logs an error instead of retrying
// forever (ADR-0005's CMS-20 addendum).
export class MemberNotFoundError extends Error {
  constructor(memberId: string) {
    super(`Members has no member ${memberId}`);
    this.name = "MemberNotFoundError";
  }
}
