import { afterEach, describe, expect, it, vi } from "vitest";
import {
  archiveMember,
  fetchMember,
  INVALID_INPUT_MESSAGE,
  registerMember,
  UNREACHABLE_MESSAGE,
} from "./membersApi";

// Unit tests: fetch is stubbed, so no members-service is needed. Each test fakes
// one response from the service and checks what the form would end up showing.

// What members-service really answers on 201 (RegisterMemberUseCase returns only the id).
// An earlier version of these tests faked a full Member here and passed, while the
// real submit redirected to ?registered=undefined. Fakes must match the real API.
const created = { id: "m-1" };

function respondWith(status: number, body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("registerMember", () => {
  it("returns the new id on 201", async () => {
    respondWith(201, created);

    const result = await registerMember({ name: "Ana", email: "ana@example.com" });

    expect(result).toEqual({ ok: true, id: "m-1", status: 201 });
  });

  it("sends the input as JSON to POST /members", async () => {
    const fetchMock = respondWith(201, created);

    await registerMember({ name: "Ana", email: "ana@example.com" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/members$/);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(init.body)).toEqual({ name: "Ana", email: "ana@example.com" });
  });

  it("passes on the service's message for a duplicate email (409)", async () => {
    respondWith(409, { error: "Email already registered" });

    const result = await registerMember({ name: "Ana", email: "ana@example.com" });

    expect(result).toEqual({ ok: false, error: "Email already registered", status: 409 });
  });

  it("passes on a domain validation message (400 { error })", async () => {
    respondWith(400, { error: "Invalid email format" });

    const result = await registerMember({ name: "Ana", email: "nope" });

    expect(result).toEqual({ ok: false, error: "Invalid email format", status: 400 });
  });

  it("hides Fastify's schema message behind a plain one (400 FST_ERR_VALIDATION)", async () => {
    respondWith(400, {
      statusCode: 400,
      code: "FST_ERR_VALIDATION",
      error: "Bad Request",
      message: "body/email must NOT have fewer than 1 characters",
    });

    const result = await registerMember({ name: "Ana", email: "" });

    expect(result).toEqual({ ok: false, error: INVALID_INPUT_MESSAGE, status: 400 });
  });

  it("treats a 201 without an id as not members-service", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("<html>proxy</html>", { status: 201 }))
    );

    const result = await registerMember({ name: "Ana", email: "ana@example.com" });

    expect(result).toEqual({ ok: false, error: UNREACHABLE_MESSAGE, status: "invalid-response" });
  });

  it("shows the generic message on a 5xx", async () => {
    respondWith(500, { error: "Internal Server Error" });

    const result = await registerMember({ name: "Ana", email: "ana@example.com" });

    expect(result).toEqual({ ok: false, error: UNREACHABLE_MESSAGE, status: 500 });
  });

  it("shows the generic message when the service can't be reached", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));

    const result = await registerMember({ name: "Ana", email: "ana@example.com" });

    expect(result).toEqual({ ok: false, error: UNREACHABLE_MESSAGE, status: "unreachable" });
  });
});

describe("fetchMember", () => {
  it("returns the member", async () => {
    const member = { id: "m-1", name: "Ana" };
    const fetchMock = respondWith(200, member);

    expect(await fetchMember("m-1")).toEqual(member);
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/members\/m-1$/);
  });

  it("returns null for an unknown id (404)", async () => {
    respondWith(404, { error: "Member not found" });

    expect(await fetchMember("nope")).toBeNull();
  });

  it("throws on other failures", async () => {
    respondWith(500, { error: "Internal Server Error" });

    await expect(fetchMember("m-1")).rejects.toThrow("members-service responded 500");
  });
});

describe("archiveMember", () => {
  it("sends DELETE /members/:id and succeeds on 204", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    expect(await archiveMember("m-1/x")).toEqual({ ok: true, status: 204 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/members\/m-1%2Fx$/);
    expect(init.method).toBe("DELETE");
  });

  it("passes on the domain's message for an already-archived member (400)", async () => {
    respondWith(400, { error: "Member is already archived" });

    expect(await archiveMember("m-1")).toEqual({
      ok: false,
      error: "Member is already archived",
      status: 400,
    });
  });

  it("passes on 'Member not found' (404)", async () => {
    respondWith(404, { error: "Member not found" });

    expect(await archiveMember("nope")).toEqual({
      ok: false,
      error: "Member not found",
      status: 404,
    });
  });

  it("shows the generic message on a 5xx", async () => {
    respondWith(500, { error: "Internal Server Error" });

    expect(await archiveMember("m-1")).toEqual({
      ok: false,
      error: UNREACHABLE_MESSAGE,
      status: 500,
    });
  });

  it("shows the generic message when the service can't be reached", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));

    expect(await archiveMember("m-1")).toEqual({
      ok: false,
      error: UNREACHABLE_MESSAGE,
      status: "unreachable",
    });
  });
});
