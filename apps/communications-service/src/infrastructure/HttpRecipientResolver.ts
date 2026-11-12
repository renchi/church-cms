import { RecipientsUnavailableError } from "../domain/errors.js";
import type { Recipient, RecipientResolver } from "../domain/RecipientResolver.js";

// The recipient resolver over Members' HTTP API: GET {membersApiUrl}/members/:id.
// Inside the cluster that's http://members-service-members-service:3001 (the
// chart's config.membersApiUrl); with `pnpm dev`, http://localhost:3001.
//
// No authentication: the request never leaves the cluster, and service-to-service
// auth waits for the Identity context (deferred, ADR-0007). A known gap.
//
// What each answer means to the message that asked:
//   200 → the recipient
//   404 → null: Members doesn't know the member, retrying won't help (term)
//   anything else, or no answer → RecipientsUnavailableError: retry later (nak)
export class HttpRecipientResolver implements RecipientResolver {
  constructor(
    private readonly membersApiUrl: string,
    // How long to wait for Members. Short: while we wait, the message isn't
    // acknowledged, and NATS redelivers it after its ack_wait (30 s).
    private readonly timeoutMs = 5_000
  ) {}

  async resolveMember(memberId: string): Promise<Recipient | null> {
    const url = new URL(`/members/${encodeURIComponent(memberId)}`, this.membersApiUrl);
    let res: Response;
    try {
      // Traced by the undici instrumentation (src/instrumentation.ts): the request
      // carries a traceparent, so Members' span joins this message's trace.
      res = await fetch(url, { signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (err) {
      // fetch says only "fetch failed"; the reason (ECONNREFUSED, a DNS error, the
      // timeout) is in its `cause`, so that goes into OUR message. Not passed on as
      // our own `cause` too: pino's error serializer appends every cause's message,
      // and the log line would say the reason twice.
      const reason = err instanceof Error && err.cause instanceof Error ? err.cause.message : String(err);
      throw new RecipientsUnavailableError(`members-service didn't answer: ${reason}`);
    }
    if (res.status === 404) return null;
    if (!res.ok) throw new RecipientsUnavailableError(`members-service answered ${res.status}`);

    // Check the shape: a wrong URL (another service answering) must not turn into
    // an email to "undefined".
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    const { id, name, email, status } = body ?? {};
    if (typeof id !== "string" || typeof name !== "string" || typeof email !== "string") {
      throw new RecipientsUnavailableError("members-service answered 200 without a member's id, name and email");
    }
    return { memberId: id, name, email, status: status === "archived" ? "archived" : "active" };
  }
}
