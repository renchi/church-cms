// The recipient resolver against a fake members-service: a real HTTP server on a
// random local port, answering what each test needs. No Docker needed.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { RecipientsUnavailableError } from "../domain/errors.js";
import { HttpRecipientResolver } from "./HttpRecipientResolver.js";

let server: Server | undefined;

// Starts a server that answers every request with `status` and `body`, and
// records the paths it was asked for. Resolves with its base URL.
async function fakeMembers(status: number, body: unknown, paths: string[] = []): Promise<string> {
  server = createServer((req, res) => {
    paths.push(req.url ?? "");
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

const member = { id: "m-1", name: "Ana", email: "ana@example.org", phone: null, status: "active", attendanceCount: 3 };

describe("HttpRecipientResolver", () => {
  it("asks Members for the member and keeps only what a recipient needs", async () => {
    const paths: string[] = [];
    const resolver = new HttpRecipientResolver(await fakeMembers(200, member, paths));

    expect(await resolver.resolveMember("m-1")).toEqual({
      memberId: "m-1",
      name: "Ana",
      email: "ana@example.org",
      status: "active",
    });
    expect(paths).toEqual(["/members/m-1"]);
  });

  it("reports an archived member as archived", async () => {
    const resolver = new HttpRecipientResolver(await fakeMembers(200, { ...member, status: "archived" }));

    expect((await resolver.resolveMember("m-1"))?.status).toBe("archived");
  });

  it("returns null when Members doesn't know the member (404)", async () => {
    const resolver = new HttpRecipientResolver(await fakeMembers(404, { error: "Member not found" }));

    expect(await resolver.resolveMember("m-404")).toBeNull();
  });

  it("is 'unavailable' (retry later) when Members fails", async () => {
    const resolver = new HttpRecipientResolver(await fakeMembers(503, { error: "down" }));

    await expect(resolver.resolveMember("m-1")).rejects.toThrow(RecipientsUnavailableError);
  });

  it("is 'unavailable' when nothing answers at all", async () => {
    const resolver = new HttpRecipientResolver("http://127.0.0.1:1");

    await expect(resolver.resolveMember("m-1")).rejects.toThrow(RecipientsUnavailableError);
  });

  it("refuses a 200 that isn't a member (a wrong URL), instead of emailing 'undefined'", async () => {
    const resolver = new HttpRecipientResolver(await fakeMembers(200, { service: "events-service", status: "ok" }));

    await expect(resolver.resolveMember("m-1")).rejects.toThrow(RecipientsUnavailableError);
  });
});
