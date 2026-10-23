import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";
import type { MemberRepository } from "../domain/MemberRepository.js";

// Unit test for what the register route *logs*. The repository is faked (as in the
// use-case tests), and the logger writes into an array instead of stdout, so the
// test can read the JSON lines that Alloy would ship to Loki.

function makeRepo(): MemberRepository {
  return {
    findById: vi.fn().mockResolvedValue(null),
    findByEmail: vi.fn().mockResolvedValue(null),
    list: vi.fn().mockResolvedValue({ members: [], total: 0 }),
    save: vi.fn().mockResolvedValue(undefined),
  };
}

describe("POST /members logging", () => {
  it("logs 'member registered' with the id and no personal data", async () => {
    const lines: string[] = [];
    const app = buildApp({
      logger: true,
      repo: makeRepo(),
      logStream: { write: (line) => void lines.push(line) },
    });

    const res = await app.inject({
      method: "POST",
      url: "/members",
      payload: { name: "Ana María", email: "ana@example.com" },
    });
    await app.close();

    expect(res.statusCode).toBe(201);
    const { id } = res.json<{ id: string }>();
    const registered = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry.msg === "member registered");

    expect(registered).toHaveLength(1);
    expect(registered[0]).toMatchObject({
      level: "info",
      service: "members-service",
      memberId: id,
    });
    // reqId ties this line to Fastify's own request lines (same service only).
    expect(registered[0]?.reqId).toBeTruthy();
    // No name or email on any line the request produced.
    const all = lines.join("");
    expect(all).not.toContain("Ana");
    expect(all).not.toContain("ana@example.com");
  });
});
