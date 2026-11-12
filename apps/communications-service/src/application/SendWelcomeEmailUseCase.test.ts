import { describe, expect, it, vi } from "vitest";
import { MemberNotFoundError, RecipientsUnavailableError } from "../domain/errors.js";
import type { Recipient, RecipientResolver } from "../domain/RecipientResolver.js";
import { WelcomeEmail, type WelcomeEmailSnapshot } from "../domain/WelcomeEmail.js";
import type { WelcomeEmailRepository } from "../domain/WelcomeEmailRepository.js";
import type { EmailSender } from "./EmailSender.js";
import { SendWelcomeEmailUseCase } from "./SendWelcomeEmailUseCase.js";
import type { UnitOfWork } from "./UnitOfWork.js";

const now = new Date("2026-11-12T10:00:00.000Z");
const ana: Recipient = { memberId: "m-1", name: "Ana", email: "ana@example.org", status: "active" };

// In-memory fakes for the four ports. The unit of work remembers message ids, like
// the real one's ProcessedMessage table, and shares the repository's rows.
function setup(opts: { recipient?: Recipient | null | Error; sendFails?: boolean } = {}) {
  const rows = new Map<string, WelcomeEmailSnapshot>();
  const processed = new Set<string>();
  const repo: WelcomeEmailRepository = {
    findByMemberId: vi.fn(async (id: string) => {
      const row = rows.get(id);
      return row ? WelcomeEmail.reconstitute(row) : null;
    }),
    save: vi.fn(async (email: WelcomeEmail) => {
      rows.set(email.toSnapshot().memberId, email.toSnapshot());
    }),
  };
  const uow: UnitOfWork = {
    runOnce: async (messageId, work) => {
      if (processed.has(messageId)) return null;
      const result = await work({ welcomeEmails: repo });
      processed.add(messageId);
      return result;
    },
  };
  const resolver: RecipientResolver = {
    resolveMember: vi.fn(async () => {
      const r = opts.recipient === undefined ? ana : opts.recipient;
      if (r instanceof Error) throw r;
      return r;
    }),
  };
  const sender: EmailSender = {
    send: vi.fn(async () => {
      if (opts.sendFails) throw new Error("SMTP connection refused");
    }),
  };
  const useCase = new SendWelcomeEmailUseCase(repo, resolver, sender, uow, {
    churchName: "Grace Community Church",
    clock: () => now,
  });
  return { useCase, rows, sender, resolver };
}

describe("SendWelcomeEmailUseCase", () => {
  it("sends the welcome email to the member's address, then records it as sent", async () => {
    const { useCase, rows, sender } = setup();

    expect(await useCase.execute({ messageId: "msg-1", memberId: "m-1" })).toBe("sent");

    expect(sender.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: "ana@example.org", subject: "Welcome to Grace Community Church, Ana!" })
    );
    expect(rows.get("m-1")).toEqual({ memberId: "m-1", status: "sent", decidedAt: now });
  });

  it("skips a member who was archived before we got to them, and records that", async () => {
    const { useCase, rows, sender } = setup({ recipient: { ...ana, status: "archived" } });

    expect(await useCase.execute({ messageId: "msg-1", memberId: "m-1" })).toBe("skipped");

    expect(sender.send).not.toHaveBeenCalled();
    expect(rows.get("m-1")?.status).toBe("skipped");
  });

  it("sends nothing for a member who already has a welcome email, even from a different message", async () => {
    const { useCase, sender } = setup();
    await useCase.execute({ messageId: "msg-1", memberId: "m-1" });

    // A second MemberRegistered for the same member (a replay, an outbox bug).
    expect(await useCase.execute({ messageId: "msg-2", memberId: "m-1" })).toBe("duplicate");

    expect(sender.send).toHaveBeenCalledTimes(1);
  });

  it("does nothing for a message it already processed (a JetStream redelivery)", async () => {
    const { useCase, rows, sender } = setup();
    await useCase.execute({ messageId: "msg-1", memberId: "m-1" });
    rows.clear(); // even without the member row, the message id alone stops it

    expect(await useCase.execute({ messageId: "msg-1", memberId: "m-1" })).toBe("duplicate");

    expect(sender.send).toHaveBeenCalledTimes(1);
  });

  it("lets 'Members is unavailable' through, so the message is retried later", async () => {
    const { useCase, rows } = setup({ recipient: new RecipientsUnavailableError("members-service: 503") });

    await expect(useCase.execute({ messageId: "msg-1", memberId: "m-1" })).rejects.toThrow(
      RecipientsUnavailableError
    );
    expect(rows.size).toBe(0);
  });

  it("reports a member that Members doesn't know: retrying can't make them appear", async () => {
    const { useCase } = setup({ recipient: null });

    await expect(useCase.execute({ messageId: "msg-1", memberId: "m-404" })).rejects.toThrow(MemberNotFoundError);
  });

  it("records nothing when the email can't be sent, so a redelivery tries again", async () => {
    const { useCase, rows } = setup({ sendFails: true });

    await expect(useCase.execute({ messageId: "msg-1", memberId: "m-1" })).rejects.toThrow("SMTP");
    expect(rows.size).toBe(0);
  });
});
