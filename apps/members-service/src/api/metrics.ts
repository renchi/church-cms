// Business metrics for the Members context (CMS-31): what members-service did,
// in the words of the domain, not of HTTP. "12 members registered, 3 refused as
// duplicates" instead of "15 POSTs, 3 of them 409".
//
// Recorded in the API layer, next to the business log lines, for the same
// reason as the spans in memberRoutes.ts: the application and domain layers stay
// free of telemetry. Exported by the OTel SDK on :9464/metrics (src/instrumentation.ts):
//   members.registered            → members_registered_total
//   members.archived              → members_archived_total
//   members.registration.failures → members_registration_failures_total{reason}
//
// `reason` has a fixed set of values (duplicate_email, invalid_input), never the
// error message or the email: every distinct label value is a time series, and
// an email would also be personal data copied into Prometheus.
//
// Counters are per Pod and in memory: they reset to 0 when a Pod restarts.
// PromQL's rate()/increase() handle that, but it's why these numbers are
// observability, not the record of what happened. The record is the database
// (and the outbox table, which the reconciliation panel compares them with).
import { metrics, type Counter } from "@opentelemetry/api";

export type RegistrationFailureReason = "duplicate_email" | "invalid_input";

export interface MemberMetrics {
  registered: Counter;
  archived: Counter;
  registrationFailures: Counter;
}

// Called once, when the routes are built. By then the SDK is registered:
// instrumentation.ts is preloaded before any app code runs (and the tests import
// it first), so the meter is the real one, not the API's no-op.
export function memberMetrics(): MemberMetrics {
  const meter = metrics.getMeter("members-service");
  return {
    registered: meter.createCounter("members.registered", {
      description: "Members registered (the 201s of POST /members)",
    }),
    archived: meter.createCounter("members.archived", {
      description: "Members archived (the 204s of DELETE /members/:id)",
    }),
    // Only the refusals the domain decides. A request the JSON schema rejects
    // before it reaches the use case (e.g. no email field at all) isn't counted
    // here; it shows up as a 400 in the HTTP metrics.
    registrationFailures: meter.createCounter("members.registration.failures", {
      description: "Registrations refused by a business rule, by reason",
    }),
  };
}
