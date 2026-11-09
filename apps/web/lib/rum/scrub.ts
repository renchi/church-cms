// Faro's `beforeSend` hook: the last stop before browser telemetry leaves the page
// (CMS-30, study-guide §14). It replaces anything shaped like an email address or a
// phone number with "[redacted]".
//
// Why a church app cares: name, email and phone are personal data, regulated even
// here. Telemetry is copied to Loki and Tempo, kept for days, and read by whoever
// debugs. So personal data must not reach it. This is one of four layers:
//   1. capture less: console `warn`/`error` only, never `setUser` (app/Rum.tsx);
//   2. THIS: scrub in the browser, before anything is sent;
//   3. scrub again in Alloy (k8s/monitoring/alloy-values.yaml, loki.process "faro"),
//      for a browser still running an old bundle;
//   4. messages name the field, never its value ("email already registered").
//
// What it can't do: recognise a NAME. "Jane Doe" looks like any other two words, so
// no pattern can catch it. Names are kept out by layers 1 and 4, not by this file.
//
// How: walk the whole item (payload and meta) and rewrite every string. Keys are
// left alone, and so are numbers, so Web Vitals values and stack line numbers survive.
// Generic on purpose: a new Faro field is covered without anyone remembering to add it.
//
// Except STRUCTURE: spans are OTLP JSON, where times are 19-digit strings
// ("startTimeUnixNano":"1762724000123456789") and ids are hex. A 19-digit string looks
// exactly like a phone number to the pattern below. The first version redacted them,
// the receiver couldn't parse "[redacted]" as a time, and rejected every batch that
// held a span (HTTP 400, which the browser never shows): no browser spans reached
// Tempo at all (study-guide §14). Those fields carry no personal data, so they skip.

import type { TransportItem } from "@grafana/faro-web-sdk";

// local@domain.tld. Deliberately broad: a false positive costs one redacted word, a
// false negative leaks an address. The local part stops at URL punctuation (/ ? = & #),
// so in `http://cms.local/members?q=jane@example.org` only the address goes, not the URL.
const EMAIL = /[^\s@"'<>()[\],;:/?=&#]+@[^\s@"'<>()[\],;:/?=&#]+\.[a-z]{2,}/gi;

// 9 or more digits, with up to two spaces, dashes or brackets between digits
// (two, for "(555) 123-4567": a bracket then a space), optionally starting with +.
// Nine, so an ISO date (2026-11-09, 8 digits) survives. Not dots: Faro's meta carries
// the browser version ("142.0.7444.162") and the user agent ("Chrome/142.0.7444.162"),
// which a dot-separated rule redacted (found in review; the same rule as Alloy's
// backstop). A phone written with dots is rare enough to leave to the other layers.
// The lookarounds stop it matching inside a longer word, which keeps hex trace and
// span ids intact (4bf92f35… is letters and digits mixed).
const PHONE = /(?<![\w.])\+?\(?\d(?:[\s()-]{0,2}\d){8,}(?![\w.])/g;

export const REDACTED = "[redacted]";

export function scrubString(value: string): string {
  return value.replace(EMAIL, REDACTED).replace(PHONE, REDACTED);
}

// Fields that are structure, never content: OTLP times and trace/span ids.
const STRUCTURAL_KEY = /UnixNano$|^(traceId|spanId|parentSpanId|trace_id|span_id)$/;

function scrubValue(value: unknown): unknown {
  if (typeof value === "string") return scrubString(value);
  if (Array.isArray(value)) return value.map(scrubValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, STRUCTURAL_KEY.test(k) ? v : scrubValue(v)])
    );
  }
  return value;
}

export function scrubItem<P>(item: TransportItem<P>): TransportItem<P> {
  return scrubValue(item) as TransportItem<P>;
}
