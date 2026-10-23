"use server";
// "use server" makes every export in this file a Server Action: a function that
// runs on the web Pod, never in the browser. When the form calls it, the browser
// sends an ordinary HTTP POST to Next.js. Next.js runs this function and sends back
// either the returned state or a redirect.
//
// Because Next.js exposes a Server Action as a POST endpoint, anyone can call it
// directly, not just through our form (Next.js data-security guide). Nothing here
// trusts the input: members-service validates everything. Auth checks would go
// here too, once Identity exists (deferred).

import { redirect } from "next/navigation";
import { logEvent } from "@/lib/log";
import { registerMember } from "@/lib/membersApi";
import type { RegisterFormState } from "./formState";

// The signature (previous state, form data) is what useActionState expects.
export async function registerMemberAction(
  _prevState: RegisterFormState,
  formData: FormData
): Promise<RegisterFormState> {
  // Each value is keyed by the input's `name` attribute; an input without a name isn't sent.
  const values = {
    name: String(formData.get("name") ?? ""),
    email: String(formData.get("email") ?? ""),
    phone: String(formData.get("phone") ?? ""),
  };

  // Sent exactly as typed. Trimming, "name is required" and "a blank phone means
  // no phone" are rules of the Member aggregate in members-service. Doing them
  // here too would duplicate them, and could hide them: a name of "   " trimmed
  // here would hit a schema check instead of the domain's "Name is required".
  const result = await registerMember(values);

  // Failure: no redirect. Return the error and the typed values for the form to show.
  // The log lines carry the outcome and the member's id, never the typed values:
  // name, email and phone are personal data (study-guide §9.9).
  // The level says whose problem it is: a 400/409 is the user's to fix (warn); a
  // 5xx, no answer, or a wrong answer is ours (error), so `level="error"` queries
  // and the dashboard's errors panel catch outages.
  if (!result.ok) {
    const userError = result.status === 400 || result.status === 409;
    logEvent(userError ? "warn" : "error", { status: result.status }, "registration failed");
    return { error: result.error, values };
  }

  // Success: Post/Redirect/Get. The browser follows the redirect with a GET, so the
  // page the user lands on came from a GET, and Refresh can't register them twice.
  // redirect() works by throwing a special error that Next.js catches, so it must
  // stay outside any try/catch, or the catch would swallow the redirect.
  // The URL carries the new member's id, not their name: the list page looks the
  // name up, so a crafted link can't make the banner say whatever it likes.
  // Logged before redirect(), which throws and ends the function.
  logEvent("info", { memberId: result.id, status: result.status }, "registration succeeded");
  redirect(`/members?registered=${encodeURIComponent(result.id)}`);
}
