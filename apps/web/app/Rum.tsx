"use client";
// Browser monitoring (RUM, "real user monitoring") with Grafana Faro (CMS-30,
// study-guide §14, ADR-0009 addendum). Rendered once by the root layout, and only
// when the chart turns it on (rum.enabled → RUM_ENABLED).
//
// What the browser reports, and where it ends up:
//   - JS errors and console warn/error  → Loki   (app="web-browser", kind="exception"/"log")
//   - Web Vitals (LCP, INP, CLS, …)     → Loki   (kind="measurement")
//   - spans for its own fetch requests  → Tempo  (through Alloy, then the OTel Collector)
// Everything goes to `/faro/collect` on THIS site: Traefik sends /faro to Alloy's
// faro.receiver (k8s/monitoring/faro-ingress.yaml). Same origin, so the browser
// needs no CORS preflight, and there is nothing secret here: any key in this file
// would be readable in the page source, which is why the endpoint is protected by
// a rate limit and a size limit instead.
//
// The trace. TracingInstrumentation starts a span for every fetch and adds the W3C
// `traceparent` header to same-origin requests. Submitting the registration form
// calls the Server Action with a same-origin fetch, so the server's spans join the
// browser's trace: one trace from the browser to events-service. Its root is the
// browser's fetch span (the request the click caused), not the click itself: a
// click span that stays the parent across `await` needs zone.js, which is deferred.

import { useEffect } from "react";
import { LogLevel, getWebInstrumentations, initializeFaro } from "@grafana/faro-web-sdk";
import { TracingInstrumentation } from "@grafana/faro-web-tracing";
import { pageId } from "@/lib/rum/page";
import { scrubItem } from "@/lib/rum/scrub";

type RumProps = {
  // The image tag (APP_VERSION from the chart): ties an error to the release it
  // happened in.
  version: string;
  // rum.debug in the chart. Turns on `?rum-test-error=1`, the deliberate error the
  // smoke test and the runbook exercise use. Off in normal deploys.
  debug: boolean;
};

// Once per page load. React runs effects twice in development, and a client-side
// navigation re-renders the layout; Faro must not start twice. Our own flag, not
// `faro.api`: before initialisation faro-core sets `faro.api` to a do-nothing
// placeholder, so "no api yet" is never true, and the first version of this guard
// silently never started Faro (study-guide §14).
let started = false;

export function Rum({ version, debug }: RumProps) {
  useEffect(() => {
    if (!started) {
      started = true;
      initializeFaro({
        url: "/faro/collect",
        // "web-browser", not "web": it becomes the spans' service.name in Tempo and the
        // `app` label in Loki, and must not be confused with the web SERVER ("web").
        app: { name: "web-browser", version },
        instrumentations: [...getWebInstrumentations(), new TracingInstrumentation()],
        // Privacy layer 1: capture less. Only console.warn and console.error, never
        // console.log/info/debug/trace, where a stray debug line could print form
        // values. And no faro.api.setUser(): we don't say who the visitor is.
        consoleInstrumentation: {
          disabledLevels: [LogLevel.TRACE, LogLevel.DEBUG, LogLevel.LOG, LogLevel.INFO],
        },
        // Privacy layer 2: scrub every item before it leaves the page (lib/rum/scrub.ts).
        beforeSend: scrubItem,
        // Group everything by route, not URL: /members/3f2c… → /members/:id. Faro calls
        // this on every navigation, client-side ones included.
        pageTracking: { generatePageId: (location) => pageId(location.pathname) },
        // Keep every session (1 = 100%). The browser is now the HEAD of the trace: its
        // sampled flag decides for web and both services too (they're ParentBased).
        // Fine at 100%; in production a client could force sampling on, so the edge
        // shouldn't trust it (study-guide §14, ADR-0009 evolution).
        sessionTracking: { samplingRate: 1 },
      });
    }

    if (debug && new URLSearchParams(window.location.search).get("rum-test-error") === "1") {
      // Thrown outside React's render, in a timer, so the page keeps working: the
      // error goes to window.onerror, where Faro's ErrorsInstrumentation picks it up.
      setTimeout(() => {
        throw new Error("RUM test error (rum-test-error=1)");
      }, 0);
    }
  }, [version, debug]);

  return null;
}
