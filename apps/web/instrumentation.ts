// OpenTelemetry for the web app (CMS-29, ADR-0009 addendum).
//
// Next.js calls register() once when the server starts, before it handles any
// request (the "instrumentation hook"; the file must sit at the app root, next
// to app/). From then on Next.js creates spans by itself for each incoming
// request, each Server Action and each fetch, because a tracer provider exists.
//
// This is where a registration's trace begins: the browser's POST to the
// Server Action is the ROOT span, and the fetch to members-service is its child.
// The fetch sends the W3C `traceparent` header, so members-service's spans join
// the same trace (browser spans come later, with Grafana Faro, CMS-30).
//
// @vercel/otel instead of the NodeSDK the services use: it is Next.js's own
// recommended wrapper, works in the bundled server, and needs no per-library
// instrumentations. It is NOT tied to Vercel's hosting: it sends OTLP to
// whatever OTEL_EXPORTER_OTLP_ENDPOINT says, here the in-cluster Collector.
import { registerOTel } from "@vercel/otel";
import { MEMBERS_API_URL } from "./lib/membersApi";

export function register(): void {
  // Off unless the Helm chart turns it on (charts/web, `tracing.otlpEndpoint`),
  // the same switch the services use. Without a Collector (`pnpm dev`, tests)
  // every export would fail.
  if (process.env.OTEL_TRACES_EXPORTER !== "otlp") return;

  registerOTel({
    serviceName: "web",
    instrumentationConfig: {
      fetch: {
        // Which outgoing requests get a `traceparent` header. @vercel/otel's
        // default is only Vercel's own deployment URLs, which would break the
        // trace right here. Allow our own API, and nothing else: a trace id sent
        // to a third-party API tells it which of our requests it is part of.
        propagateContextUrls: [MEMBERS_API_URL],
      },
    },
  });
}
