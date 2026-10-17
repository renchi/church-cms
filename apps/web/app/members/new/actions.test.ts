import { beforeEach, describe, expect, it, vi } from "vitest";
import { redirect } from "next/navigation";
import { registerMember } from "@/lib/membersApi";
import { registerMemberAction } from "./actions";
import { initialRegisterFormState } from "./formState";

// The Server Action is tested as a plain async function. Its two collaborators
// are mocked: the members-service client, and Next's redirect() (a spy here,
// rather than the real one that throws to end the request).
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/membersApi", () => ({ registerMember: vi.fn() }));

function formData(fields: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

beforeEach(() => {
  vi.mocked(redirect).mockReset();
  vi.mocked(registerMember).mockReset();
});

describe("registerMemberAction", () => {
  it("redirects to the list with the new member's id on success", async () => {
    vi.mocked(registerMember).mockResolvedValue({ ok: true, id: "m-1/x" });

    await registerMemberAction(
      initialRegisterFormState,
      formData({ name: "Ana María", email: "ana@example.com", phone: "" })
    );

    // The id, not the name (the list page looks the name up), encoded for the query string.
    expect(redirect).toHaveBeenCalledWith("/members?registered=m-1%2Fx");
  });

  it("sends the values exactly as typed: trimming and blank phone are domain rules", async () => {
    vi.mocked(registerMember).mockResolvedValue({ ok: true, id: "m-1" });

    await registerMemberAction(
      initialRegisterFormState,
      formData({ name: "  Ana ", email: " ana@example.com", phone: "   " })
    );

    expect(registerMember).toHaveBeenCalledWith({
      name: "  Ana ",
      email: " ana@example.com",
      phone: "   ",
    });
  });

  it("returns the error and the typed values on failure, without redirecting", async () => {
    vi.mocked(registerMember).mockResolvedValue({ ok: false, error: "Email already registered" });
    const typed = { name: "Ana María", email: "ana@example.com", phone: "555-0100" };

    const state = await registerMemberAction(initialRegisterFormState, formData(typed));

    expect(state).toEqual({ error: "Email already registered", values: typed });
    expect(redirect).not.toHaveBeenCalled();
  });
});
