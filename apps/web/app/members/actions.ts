"use server";
// The Archive button's Server Action (see new/actions.ts for what "use server"
// means and why nothing here trusts its input).
//
// It is also the root of the longest trace in the system (CMS-29): this action
// → DELETE /members/:id → ArchiveMemberUseCase → outbox row → relay → NATS →
// events-service's consumer, which declines the member's future volunteer
// assignments. One click, one trace across both services and the bus
// (docs/observability.md, "Follow one archive").

import { redirect } from "next/navigation";
import { logEvent } from "@/lib/log";
import { archiveMember } from "@/lib/membersApi";
import type { ArchiveState } from "./archiveState";

export async function archiveMemberAction(
  _prevState: ArchiveState,
  formData: FormData
): Promise<ArchiveState> {
  // The id comes from a hidden input, so anyone can post any value: members-service
  // answers 404 for an unknown one, and that message is shown as-is.
  const id = String(formData.get("id") ?? "");
  const result = await archiveMember(id);

  // Same log levels as registration: a 400/404 is the user's (warn), the rest is
  // ours (error). The member's id only, never personal data.
  if (!result.ok) {
    const userError = result.status === 400 || result.status === 404;
    logEvent(
      userError ? "warn" : "error",
      { memberId: id, status: result.status },
      "archive failed"
    );
    return { error: result.error };
  }

  // Post/Redirect/Get, like registration: the banner looks the name up by id.
  // redirect() throws, so it stays last and outside any try/catch.
  logEvent("info", { memberId: id, status: result.status }, "archive succeeded");
  redirect(`/members?archived=${encodeURIComponent(id)}`);
}
