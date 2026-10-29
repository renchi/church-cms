"use client";
// One Archive button per active member on the list. A Client Component for the
// same reason as RegisterForm: it shows state that changes on the page
// ("Archiving…" while the request runs, then an error if it failed).

import { useActionState } from "react";
import { archiveMemberAction } from "./actions";
import { initialArchiveState } from "./archiveState";

export function ArchiveButton({ memberId }: { memberId: string }) {
  const [state, formAction, isPending] = useActionState(archiveMemberAction, initialArchiveState);

  return (
    <form action={formAction} className="inline">
      {/* The id travels in the form. It isn't trusted: members-service looks it up. */}
      <input type="hidden" name="id" value={memberId} />
      <button
        type="submit"
        disabled={isPending}
        className="rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-700 hover:bg-gray-100 disabled:opacity-50"
      >
        {isPending ? "Archiving…" : "Archive"}
      </button>
      {state.error && (
        <span role="alert" className="ml-2 text-xs text-red-700">
          {state.error}
        </span>
      )}
    </form>
  );
}
