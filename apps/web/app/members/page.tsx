// Server component: fetches the member list from members-service at request time.

import { logEvent } from "@/lib/log";
import Link from "next/link";
import {
  fetchMember,
  fetchMembers,
  MEMBERS_API_URL,
  type Member,
  type MemberListResponse,
} from "@/lib/membersApi";

// In Next.js 15, searchParams is a Promise: the page awaits it. A repeated
// parameter (?registered=a&registered=b) arrives as an array, hence the union.
interface MembersPageProps {
  searchParams: Promise<{ registered?: string | string[] }>;
}

// The registration Server Action redirects to /members?registered=<id>. The banner
// shows the name members-service has for that id, so a crafted link can't make it
// say anything else. An unknown id, an array or a lookup failure: no banner.
async function findRegistered(registered: string | string[] | undefined): Promise<Member | null> {
  if (typeof registered !== "string" || !registered) return null;
  try {
    return await fetchMember(registered);
  } catch {
    return null;
  }
}

export default async function MembersPage({ searchParams }: MembersPageProps) {
  const registered = await findRegistered((await searchParams).registered);
  let response: MemberListResponse | null = null;
  let failed = false;

  try {
    response = await fetchMembers();
  } catch (err) {
    // The details (including the internal MEMBERS_API_URL) go to the server log,
    // not to the visitor's browser: one JSON line at level "error", so Loki's
    // `{app="web"} | json | level="error"` and the dashboard's errors panel find it.
    logEvent("error", { url: MEMBERS_API_URL, err }, "could not load members");
    failed = true;
  }

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">Members</h1>
        <Link
          href="/members/new"
          className="rounded bg-gray-900 px-3 py-2 text-sm font-medium text-white hover:bg-gray-700"
        >
          Register member
        </Link>
      </div>

      {registered && (
        <div
          role="status"
          className="rounded border border-green-200 bg-green-50 p-4 text-sm text-green-700"
        >
          Registered {registered.name}
        </div>
      )}

      {failed && (
        <div className="rounded border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          Could not load members. Try again in a moment.
        </div>
      )}

      {response && response.data.length === 0 && <p className="text-gray-600">No members yet.</p>}

      {response && response.data.length > 0 && (
        <p className="text-sm text-gray-500">
          Showing {response.data.length} of {response.meta?.total ?? response.data.length}{" "}
          {(response.meta?.total ?? response.data.length) === 1 ? "member" : "members"}
        </p>
      )}

      {response && response.data.length > 0 && (
        <table className="w-full border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-gray-200 text-gray-500">
              <th className="py-2 pr-4 font-medium">Name</th>
              <th className="py-2 pr-4 font-medium">Email</th>
              <th className="py-2 pr-4 font-medium">Phone</th>
              <th className="py-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {response.data.map((member) => (
              <tr key={member.id} className="border-b border-gray-100">
                <td className="py-2 pr-4">{member.name}</td>
                <td className="py-2 pr-4 text-gray-600">{member.email}</td>
                <td className="py-2 pr-4 text-gray-600">{member.phone ?? "—"}</td>
                <td className="py-2">
                  <span
                    className={
                      member.status === "active"
                        ? "rounded bg-green-100 px-2 py-0.5 text-xs text-green-700"
                        : "rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600"
                    }
                  >
                    {member.status}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
