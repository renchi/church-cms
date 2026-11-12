import { describe, expect, it } from "vitest";
import { DomainError } from "./errors.js";
import { WelcomeEmail } from "./WelcomeEmail.js";

const at = new Date("2026-11-12T10:00:00.000Z");

describe("WelcomeEmail", () => {
  it("records a welcome email that was sent, for one member", () => {
    const email = WelcomeEmail.sent("m-1", at);

    expect(email.toSnapshot()).toEqual({ memberId: "m-1", status: "sent", decidedAt: at });
  });

  it("records a skipped welcome email: the member was archived before it went out", () => {
    const email = WelcomeEmail.skipped("m-1", at);

    expect(email.toSnapshot()).toEqual({ memberId: "m-1", status: "skipped", decidedAt: at });
  });

  it("needs a member", () => {
    expect(() => WelcomeEmail.sent("", at)).toThrow(DomainError);
    expect(() => WelcomeEmail.skipped("  ", at)).toThrow(DomainError);
  });

  it("comes back from storage unchanged", () => {
    const snapshot = { memberId: "m-2", status: "sent" as const, decidedAt: at };

    expect(WelcomeEmail.reconstitute(snapshot).toSnapshot()).toEqual(snapshot);
  });
});
