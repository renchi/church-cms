// The registration funnel, seen from the browser (CMS-31): how many people pressed
// "Register member", and how many got to the "Registered …" banner. The difference
// is what users felt: a refused form, an error page, or giving up while it loaded.
// The server can't see the people who never got a response.
//
// Each step is a Faro custom EVENT (only from a Client Component). Alloy's receiver
// turns it into a Loki line with kind="event" and event_name=registration_<step>,
// which the "Registration journey" dashboard counts
// (k8s/monitoring/registration-journey-dashboard.yaml, Client row).
//
// An event is only a NAME, no attributes: nothing the visitor typed, and no member
// id. The funnel needs counts, not who (privacy layer 1, study-guide §14).
//
// Safe with RUM off: before initializeFaro runs, `faro.api` is a do-nothing
// placeholder (app/Rum.tsx), so these calls simply do nothing.
import { faro } from "@grafana/faro-web-sdk";

export type RegistrationStep = "submitted" | "completed";

export function trackRegistration(step: RegistrationStep): void {
  faro.api.pushEvent(`registration_${step}`);
}
