import { MemberNotFoundError } from "../domain/errors.js";
import type { RecipientResolver } from "../domain/RecipientResolver.js";
import { WelcomeEmail } from "../domain/WelcomeEmail.js";
import type { WelcomeEmailRepository } from "../domain/WelcomeEmailRepository.js";
import { welcomeMessage } from "../domain/WelcomeMessage.js";
import type { EmailSender } from "./EmailSender.js";
import type { UnitOfWork } from "./UnitOfWork.js";

// What happened to one MemberRegistered message. It becomes the `outcome` label of
// messages_consumed_total (packages/events/src/metrics.ts), so it's a short fixed word.
export type WelcomeOutcome = "sent" | "skipped" | "duplicate";

// Reacts to MemberRegistered: one welcome email per member, ever.
//
// THE HARD PART: an email can't be rolled back. The database can undo a row, but
// not a message that has left. So something can always go wrong BETWEEN the send
// and the record, and we had to choose which way it goes wrong (ADR-0005's
// CMS-20 addendum):
//   - send, then record  → a crash in between sends it AGAIN on redelivery
//                          (at-least-once: a rare duplicate welcome)
//   - record, then send  → a failed send is never retried
//                          (at-most-once: a rare lost welcome)
// We send first: a duplicate welcome is harmless, a lost one goes unnoticed.
export class SendWelcomeEmailUseCase {
  constructor(
    private readonly repo: WelcomeEmailRepository,
    private readonly resolver: RecipientResolver,
    private readonly sender: EmailSender,
    private readonly uow: UnitOfWork,
    private readonly opts: { churchName: string; clock?: () => Date }
  ) {}

  async execute(input: { messageId: string; memberId: string }): Promise<WelcomeOutcome> {
    const { messageId, memberId } = input;

    // 1. Already decided for this member? Then a second message for them (a replay,
    //    an outbox bug) is a duplicate, whatever its message id.
    if (await this.repo.findByMemberId(memberId)) return "duplicate";

    // 2. Who is it? Asked OUTSIDE the transaction below, so no database
    //    transaction stays open while we wait on another service's HTTP answer.
    //    Unavailable → RecipientsUnavailableError goes up, the message is retried.
    const recipient = await this.resolver.resolveMember(memberId);
    if (!recipient) throw new MemberNotFoundError(memberId);

    // 3. Decide, send and record, once per message id.
    const outcome = await this.uow.runOnce(messageId, async ({ welcomeEmails }) => {
      const now = (this.opts.clock ?? (() => new Date()))();
      if (recipient.status === "archived") {
        await welcomeEmails.save(WelcomeEmail.skipped(memberId, now));
        return "skipped" as const;
      }
      const message = welcomeMessage({ churchName: this.opts.churchName, recipientName: recipient.name });
      // Send FIRST, then record. If the send throws, nothing is saved (the
      // transaction rolls back) and the redelivery tries again. If the save fails
      // after a successful send (a crash, or another Pod saved this member a
      // moment earlier), the redelivery may send again: the accepted cost.
      await this.sender.send({ to: recipient.email, ...message });
      await welcomeEmails.save(WelcomeEmail.sent(memberId, now));
      return "sent" as const;
    });
    // null: this exact message was processed before.
    return outcome ?? "duplicate";
  }
}
