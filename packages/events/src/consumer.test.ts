import { describe, expect, it, vi } from "vitest";
import { InvalidMessageError, parseMemberArchived } from "./contract.js";
import { handleMessage, nakDelayMs, type AckableMessage } from "./consumer.js";

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const valid = {
  id: "msg-1",
  type: "MemberArchived",
  version: 1,
  occurredAt: "2026-10-15T10:00:00.000Z",
  data: { memberId: "m-1" },
};

function fakeMessage(body: unknown, deliveryCount = 1): AckableMessage {
  return {
    subject: "cms.members.archived",
    info: { deliveryCount, streamSequence: 7 },
    json: <T>() => {
      if (body instanceof Error) throw body; // what JsMsg.json() does on bad JSON
      return body as T;
    },
    ack: vi.fn(),
    nak: vi.fn(),
    term: vi.fn(),
  };
}

describe("handleMessage", () => {
  it("acks after the handler succeeds", async () => {
    const msg = fakeMessage(valid);
    const handle = vi.fn().mockResolvedValue(undefined);

    await handleMessage(msg, parseMemberArchived, handle, log);

    expect(handle).toHaveBeenCalledWith(valid);
    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.nak).not.toHaveBeenCalled();
  });

  it("terminates a message that isn't valid JSON, without calling the handler", async () => {
    const msg = fakeMessage(new SyntaxError("Unexpected token"));
    const handle = vi.fn();

    await handleMessage(msg, parseMemberArchived, handle, log);

    expect(msg.term).toHaveBeenCalledOnce();
    expect(handle).not.toHaveBeenCalled();
  });

  it("terminates a message that breaks the contract", async () => {
    const msg = fakeMessage({ ...valid, version: 99 });

    await handleMessage(msg, parseMemberArchived, vi.fn(), log);

    expect(msg.term).toHaveBeenCalledOnce();
    expect(msg.ack).not.toHaveBeenCalled();
  });

  it("terminates when the handler rejects the message as invalid", async () => {
    const msg = fakeMessage(valid);
    const handle = vi.fn().mockRejectedValue(new InvalidMessageError("bad"));

    await handleMessage(msg, parseMemberArchived, handle, log);

    expect(msg.term).toHaveBeenCalledWith("bad");
  });

  it("naks with a backoff delay when the handler fails, so it's redelivered", async () => {
    const msg = fakeMessage(valid, 3);
    const handle = vi.fn().mockRejectedValue(new Error("database down"));

    await handleMessage(msg, parseMemberArchived, handle, log);

    expect(msg.nak).toHaveBeenCalledWith(4000);
    expect(msg.ack).not.toHaveBeenCalled();
  });
});

describe("nakDelayMs", () => {
  it("doubles per attempt and caps at 30 s", () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(nakDelayMs)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });
});
