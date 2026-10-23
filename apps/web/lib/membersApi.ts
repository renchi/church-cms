// The one place in the web app that talks to members-service.
//
// Everything here runs on the SERVER only: in Server Components (the members
// pages) and in the registration Server Action. The browser never calls
// members-service directly, because MEMBERS_API_URL is a cluster-internal
// address (http://members-service-members-service:3001 in minikube,
// http://members-service:3001 in Compose) that a browser can't resolve.
// That's also why the variable has no NEXT_PUBLIC_ prefix: that prefix would
// copy the value into the JavaScript sent to the browser.

export type MemberStatus = "active" | "archived";

export interface Member {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  status: MemberStatus;
  createdAt: string;
  updatedAt: string;
}

export interface MemberListResponse {
  data: Member[];
  meta: { page: number; limit: number; total: number; pages: number };
}

// localhost:3001 is the fallback for `pnpm dev`, where both apps run on the host.
export const MEMBERS_API_URL = process.env.MEMBERS_API_URL ?? "http://localhost:3001";

export async function fetchMembers(): Promise<MemberListResponse> {
  // no-store: always show fresh data from the service rather than a cached snapshot.
  // It also means a member registered a moment ago appears without revalidatePath().
  const res = await fetch(`${MEMBERS_API_URL}/members`, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`members-service responded ${res.status}`);
  }
  // Validate the shape so an unexpected 200 payload (e.g. a misconfigured URL
  // pointing at another service) surfaces as the error state, not a render crash.
  const body = (await res.json()) as Partial<MemberListResponse>;
  if (!Array.isArray(body.data)) {
    throw new Error("Unexpected response shape from members-service");
  }
  return body as MemberListResponse;
}

// One member by id, or null if there's no such member (404). Used to confirm a
// registration by the member's real name, rather than echoing text from the URL.
export async function fetchMember(id: string): Promise<Member | null> {
  const res = await fetch(`${MEMBERS_API_URL}/members/${encodeURIComponent(id)}`, {
    cache: "no-store",
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`members-service responded ${res.status}`);
  return (await res.json()) as Member;
}

export interface RegisterMemberInput {
  name: string;
  email: string;
  phone?: string;
}

// A result instead of a thrown error: a duplicate email is an expected outcome
// the form has to display, not an exceptional crash.
// On success members-service returns only the new id (201 { id }), not the whole member.
// `status` is for the logs (the Server Action logs it on both outcomes): the HTTP
// status members-service answered, "unreachable" when no response came back at all,
// or "invalid-response" when the answer wasn't members-service's (a 201 with no id).
// On failure, `error` is the text for the user.
export type RegisterMemberResult =
  | { ok: true; id: string; status: number }
  | { ok: false; error: string; status: number | "unreachable" | "invalid-response" };

export const UNREACHABLE_MESSAGE = "Couldn't reach the members service, try again.";
export const INVALID_INPUT_MESSAGE =
  "Some fields are missing or invalid. Check the form and try again.";

export async function registerMember(input: RegisterMemberInput): Promise<RegisterMemberResult> {
  let res: Response;
  try {
    res = await fetch(`${MEMBERS_API_URL}/members`, {
      method: "POST",
      // The browser sent us urlencoded form data; members-service speaks JSON.
      // Translating between the two is this module's job.
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      cache: "no-store",
    });
  } catch {
    // fetch only throws when there's no HTTP response at all (DNS, connection refused).
    return { ok: false, error: UNREACHABLE_MESSAGE, status: "unreachable" };
  }

  // Never let a body we can't parse throw out of the Server Action: that would
  // replace the form with Next's error page instead of showing a banner.
  const body = (await res.json().catch(() => ({}))) as {
    id?: unknown;
    error?: string;
    code?: string;
  };

  if (res.status === 201) {
    // A 201 without an id isn't members-service (e.g. a misconfigured URL).
    if (typeof body.id === "string") return { ok: true, id: body.id, status: res.status };
    // Not logged as 201: "registration failed, status 201" would read like a success.
    return { ok: false, error: UNREACHABLE_MESSAGE, status: "invalid-response" };
  }

  // 400 (invalid input) and 409 (email already registered) are the user's to fix.
  if (res.status === 400 || res.status === 409) {
    // Two shapes reach us. Fastify's own schema validation (e.g. a missing field):
    // { code: "FST_ERR_VALIDATION", message: "body/email must NOT have fewer than 1
    // characters" }. That's written for developers, so the user gets a plain message.
    if (body.code === "FST_ERR_VALIDATION") {
      return { ok: false, error: INVALID_INPUT_MESSAGE, status: res.status };
    }
    // Domain errors: { error: "Invalid email format" }. Those are shown as-is: the
    // rules live in the Member aggregate, so the UI doesn't duplicate them (or their wording).
    if (body.error) return { ok: false, error: body.error, status: res.status };
  }

  // 5xx, or a 4xx without a readable message: not something the user can fix.
  return { ok: false, error: UNREACHABLE_MESSAGE, status: res.status };
}
