import { DomainError } from "./errors.js";

// What Communications decided about one member's welcome email (GLOSSARY.md).
//   sent    — the email provider accepted it for delivery
//   skipped — the member was already archived when we came to send it
// There is no "pending": the decision is recorded only once it's made. The
// welcome email is sent FIRST and recorded after (at-least-once, ADR-0005's
// CMS-20 addendum), so "no WelcomeEmail yet" simply means "not done yet".
export type WelcomeEmailStatus = "sent" | "skipped";

export interface WelcomeEmailSnapshot {
  memberId: string; // a reference to Members, by id only (ADR-0005)
  status: WelcomeEmailStatus;
  decidedAt: Date;
}

// The aggregate. Small on purpose: its one invariant, "at most one welcome email
// per member", needs every WelcomeEmail at once to check, so the repository's
// storage enforces it (memberId is the primary key, prisma/schema.prisma), not
// this class. What the class guarantees is that every record names a member and
// one of the two outcomes.
export class WelcomeEmail {
  private constructor(private readonly snap: WelcomeEmailSnapshot) {}

  static sent(memberId: string, at: Date): WelcomeEmail {
    return WelcomeEmail.decide(memberId, "sent", at);
  }

  static skipped(memberId: string, at: Date): WelcomeEmail {
    return WelcomeEmail.decide(memberId, "skipped", at);
  }

  private static decide(memberId: string, status: WelcomeEmailStatus, at: Date): WelcomeEmail {
    if (!memberId.trim()) throw new DomainError("A welcome email needs a member");
    return new WelcomeEmail({ memberId, status, decidedAt: at });
  }

  toSnapshot(): WelcomeEmailSnapshot {
    return { ...this.snap };
  }

  // From storage: the data was valid when it was saved, so no checks again.
  static reconstitute(snapshot: WelcomeEmailSnapshot): WelcomeEmail {
    return new WelcomeEmail({ ...snapshot });
  }
}
