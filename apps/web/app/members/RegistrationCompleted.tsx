"use client";
// Sends the "completed" step of the registration funnel (lib/rum/funnel.ts) when the
// "Registered …" banner appears. The members page is a Server Component, which can't
// talk to Faro in the browser, so this tiny Client Component does it. It renders
// nothing.
//
// Only when the banner shows, i.e. the page found the member the redirect named, so a
// hand-typed ?registered= link to a member that doesn't exist isn't counted.
// A Refresh of the page counts again; the dashboard reads it as an approximation.

import { useEffect } from "react";
import { trackRegistration } from "@/lib/rum/funnel";

export function RegistrationCompleted() {
  useEffect(() => {
    trackRegistration("completed");
  }, []);
  return null;
}
