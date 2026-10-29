import { beforeEach, describe, expect, it, vi } from "vitest";
import { redirect } from "next/navigation";
import { logEvent } from "@/lib/log";
import { archiveMember } from "@/lib/membersApi";
import { archiveMemberAction } from "./actions";
import { initialArchiveState } from "./archiveState";

// Tested like the registration action (new/actions.test.ts): a plain async
// function with the members-service client, redirect() and logEvent mocked.
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/membersApi", () => ({ archiveMember: vi.fn() }));
vi.mock("@/lib/log", () => ({ logEvent: vi.fn() }));

function formData(id: string) {
  const data = new FormData();
  data.set("id", id);
  return data;
}

beforeEach(() => {
  vi.mocked(redirect).mockReset();
  vi.mocked(archiveMember).mockReset();
  vi.mocked(logEvent).mockReset();
});

describe("archiveMemberAction", () => {
  it("archives the member and redirects to the list with its id", async () => {
    vi.mocked(archiveMember).mockResolvedValue({ ok: true, status: 204 });

    await archiveMemberAction(initialArchiveState, formData("m-1/x"));

    expect(archiveMember).toHaveBeenCalledWith("m-1/x");
    expect(redirect).toHaveBeenCalledWith("/members?archived=m-1%2Fx");
    expect(logEvent).toHaveBeenCalledWith(
      "info",
      { memberId: "m-1/x", status: 204 },
      "archive succeeded"
    );
  });

  it("returns the service's message on failure, without redirecting", async () => {
    vi.mocked(archiveMember).mockResolvedValue({
      ok: false,
      error: "Member is already archived",
      status: 400,
    });

    const state = await archiveMemberAction(initialArchiveState, formData("m-1"));

    expect(state).toEqual({ error: "Member is already archived" });
    expect(redirect).not.toHaveBeenCalled();
  });

  it.each([
    [500, "error"],
    ["unreachable", "error"],
    [400, "warn"],
    [404, "warn"],
  ] as const)("logs a %s failure at %s", async (status, level) => {
    vi.mocked(archiveMember).mockResolvedValue({ ok: false, error: "x", status });

    await archiveMemberAction(initialArchiveState, formData("m-1"));

    expect(logEvent).toHaveBeenCalledWith(level, { memberId: "m-1", status }, "archive failed");
  });
});
