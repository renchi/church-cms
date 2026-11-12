// ADR-0005's recipient resolver: how Communications asks Members who someone is,
// at the moment of sending (GLOSSARY.md). A DOMAIN SERVICE, not part of an
// aggregate, because answering it crosses into another context.
//
// Why ask at send time, instead of keeping a copy? Members is the core domain and
// owns person data (context map). A copy here would go stale (a new email
// address), and would put personal data in a second database. MemberRegistered is
// thin, `{ memberId }`, for the same reason (CMS-27): the event says THAT something
// happened, and whoever needs the details asks the owner.
//
// The adapter that calls Members' HTTP API is infrastructure/HttpRecipientResolver.ts.
// ADR-0005 also plans `resolve(group)` for campaigns; it arrives with campaigns.

// A member as Communications sees them at send time. Never stored.
export interface Recipient {
  memberId: string;
  name: string;
  email: string;
  // Archived members get no welcome email (ADR-0005's CMS-20 addendum).
  status: "active" | "archived";
}

export interface RecipientResolver {
  // The member, or null if Members doesn't know the id.
  // Throws RecipientsUnavailableError when Members can't answer right now.
  resolveMember(memberId: string): Promise<Recipient | null>;
}
