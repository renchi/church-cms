"use client";
// The only Client Component in the registration flow. It needs to run in the
// browser because it shows state that changes while the user is on the page:
// "Registering…" while the request is in flight, and the error banner afterwards.
// Everything else (the page around it, the action, the API call) runs on the server.

import { useActionState } from "react";
import { registerMemberAction } from "./actions";
import { initialRegisterFormState } from "./formState";

export function RegisterForm() {
  // useActionState wires the form to the Server Action:
  //   state     — whatever the action last returned (error + typed values)
  //   formAction — passed to <form action>; submitting POSTs to the server
  //   isPending — true while that POST is in flight
  const [state, formAction, isPending] = useActionState(
    registerMemberAction,
    initialRegisterFormState
  );

  return (
    <form action={formAction} className="space-y-4">
      {state.error && (
        <div
          role="alert"
          className="rounded border border-red-200 bg-red-50 p-4 text-sm text-red-700"
        >
          {state.error}
        </div>
      )}

      {/* Validation belongs to the Member aggregate in members-service. These
          attributes are only browser hints that catch typos before a round trip.
          They are not the rules, and the service checks everything again. */}
      <label className="block">
        <span className="text-sm font-medium text-gray-700">Name</span>
        <input
          name="name"
          required
          autoComplete="name"
          defaultValue={state.values.name}
          className="mt-1 block w-full rounded border border-gray-300 px-3 py-2"
        />
      </label>

      <label className="block">
        <span className="text-sm font-medium text-gray-700">Email</span>
        <input
          name="email"
          type="email"
          required
          autoComplete="email"
          defaultValue={state.values.email}
          className="mt-1 block w-full rounded border border-gray-300 px-3 py-2"
        />
      </label>

      <label className="block">
        <span className="text-sm font-medium text-gray-700">
          Phone <span className="font-normal text-gray-500">(optional)</span>
        </span>
        <input
          name="phone"
          type="tel"
          autoComplete="tel"
          defaultValue={state.values.phone}
          className="mt-1 block w-full rounded border border-gray-300 px-3 py-2"
        />
      </label>

      {/* Disabled while pending: redirecting after success stops a Refresh from
          re-submitting, but not a double-click. This does. */}
      <button
        type="submit"
        disabled={isPending}
        className="w-full rounded bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50 sm:w-auto"
      >
        {isPending ? "Registering…" : "Register member"}
      </button>
    </form>
  );
}
