// Server component: fetches the member list from members-service at request time.

type MemberStatus = "active" | "archived";

interface Member {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  status: MemberStatus;
  createdAt: string;
  updatedAt: string;
}

interface MemberListResponse {
  data: Member[];
  meta: { page: number; limit: number; total: number; pages: number };
}

const API_URL = process.env.NEXT_PUBLIC_MEMBERS_API_URL ?? "http://localhost:3001";

async function fetchMembers(): Promise<MemberListResponse> {
  // no-store: always show fresh data from the service rather than a cached snapshot.
  const res = await fetch(`${API_URL}/members`, { cache: "no-store" });
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

export default async function MembersPage() {
  let response: MemberListResponse | null = null;
  let error: string | null = null;

  try {
    response = await fetchMembers();
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to reach members-service";
  }

  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-semibold">Members</h1>

      {error && (
        <div className="rounded border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          Could not load members from <code>{API_URL}</code>: {error}
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
