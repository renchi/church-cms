import { SUBJECTS } from "@cms/events";
import { describe, expect, it } from "vitest";
import { toOutboxMessage } from "./outbox.js";

const occurredAt = new Date("2026-10-23T10:00:00.000Z");

describe("toOutboxMessage", () => {
  it("maps MemberRegistered to a thin message on cms.members.registered", () => {
    const message = toOutboxMessage({ type: "MemberRegistered", memberId: "m-1", occurredAt });

    expect(message).not.toBeNull();
    expect(message!.subject).toBe(SUBJECTS.memberRegistered);
    // The outbox row id and the envelope id are the same: it becomes the
    // Nats-Msg-Id header and the consumer's dedupe key.
    expect(message!.payload).toEqual({
      id: message!.id,
      type: "MemberRegistered",
      version: 1,
      occurredAt: "2026-10-23T10:00:00.000Z",
      // Exactly { memberId }: no person data leaves the Members context.
      data: { memberId: "m-1" },
    });
  });

  it("maps MemberArchived to cms.members.archived", () => {
    const message = toOutboxMessage({ type: "MemberArchived", memberId: "m-1", occurredAt });

    expect(message!.subject).toBe(SUBJECTS.memberArchived);
    expect(message!.payload).toEqual({
      id: message!.id,
      type: "MemberArchived",
      version: 1,
      occurredAt: "2026-10-23T10:00:00.000Z",
      data: { memberId: "m-1" },
    });
  });

  it("gives every message its own id", () => {
    const event = { type: "MemberRegistered" as const, memberId: "m-1", occurredAt };
    expect(toOutboxMessage(event)!.id).not.toBe(toOutboxMessage(event)!.id);
  });

  it("returns null for MemberUpdated, which no other context consumes", () => {
    expect(toOutboxMessage({ type: "MemberUpdated", memberId: "m-1", occurredAt })).toBeNull();
  });
});
