import { describe, expect, it } from "vitest";
import type { TransportItem } from "@grafana/faro-web-sdk";
import { REDACTED, scrubItem, scrubString } from "./scrub";

// Shaped like what Faro really sends, trimmed to the fields that matter here.
function item(type: string, payload: unknown, meta: unknown = {}): TransportItem {
  return { type, payload, meta } as TransportItem;
}

describe("scrubString", () => {
  it("redacts email addresses", () => {
    expect(scrubString("jane.doe+church@example.org is already registered")).toBe(
      `${REDACTED} is already registered`
    );
  });

  it("redacts phone numbers in common shapes", () => {
    for (const phone of ["+44 7700 900123", "(555) 123-4567", "07700900123", "+1 555-123-4567"]) {
      expect(scrubString(`call ${phone} today`)).toBe(`call ${REDACTED} today`);
    }
  });

  it("keeps things that only look number-ish", () => {
    const safe = [
      "2026-11-09T21:00:00.000Z", // ISO timestamp: 8 digits before the T
      "4bf92f3577b34da6a3ce929d0e0e4736", // trace id
      "00f067aa0ba902b7", // span id
      "/members/3f2c8a1e-5b7d-4c1e-9a0b-1234567890ab", // member id in a URL
      "http://cms.local/_next/static/chunks/app/members/page-1a2b3c4d.js:1:28432", // stack frame
      "LCP 2412.5", // a Web Vitals value as text
      "142.0.7444.162", // a browser version (Faro's meta.browser.version)
      "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.7444.162 Mobile Safari/537.36", // userAgent
    ];
    for (const s of safe) expect(scrubString(s)).toBe(s);
  });
});

describe("scrubItem", () => {
  it("scrubs an exception's message and its context, but not its frames' numbers", () => {
    const out = scrubItem(
      item("exception", {
        type: "Error",
        value: "duplicate: jane@example.org",
        stacktrace: { frames: [{ filename: "http://cms.local/_next/static/chunks/a.js", lineno: 1, colno: 9 }] },
        context: { field: "email", input: "jane@example.org" },
      })
    );
    expect(out.payload).toEqual({
      type: "Error",
      value: `duplicate: ${REDACTED}`,
      stacktrace: { frames: [{ filename: "http://cms.local/_next/static/chunks/a.js", lineno: 1, colno: 9 }] },
      context: { field: "email", input: REDACTED },
    });
  });

  it("scrubs a console log's message", () => {
    const out = scrubItem(item("log", { level: "warn", message: "retrying for 07700900123", context: {} }));
    expect(out.payload).toEqual({ level: "warn", message: `retrying for ${REDACTED}`, context: {} });
  });

  it("leaves a Web Vitals measurement's values alone", () => {
    const payload = { type: "web-vitals", values: { lcp: 2412.5, cls: 0.02 }, context: { rating: "good" } };
    expect(scrubItem(item("measurement", payload)).payload).toEqual(payload);
  });

  it("scrubs the meta too: a page URL with an address in its query string", () => {
    const out = scrubItem(
      item("event", { name: "page_view" }, { page: { id: "/members", url: "http://cms.local/members?q=jane@example.org" } })
    );
    expect(out.meta).toEqual({ page: { id: "/members", url: `http://cms.local/members?q=${REDACTED}` } });
  });

  it("keeps a span's structure (times, ids) but scrubs its attribute values", () => {
    // A real OTLP span as Faro sends it. Its times are 19-digit strings: scrubbing them
    // made the receiver reject the whole batch (HTTP 400), so no browser span arrived.
    const span = {
      traceId: "3077b790e99f27d6f2d6ad8f35d211f8",
      spanId: "c5eba07b2ef9b5d4",
      parentSpanId: "",
      name: "POST",
      kind: 3,
      startTimeUnixNano: "1762724000123456789",
      endTimeUnixNano: "1762724000456789012",
      attributes: [
        { key: "url.full", value: { stringValue: "http://cms.local/members?q=jane@example.org" } },
        { key: "http.response.status_code", value: { intValue: 303 } },
      ],
    };
    const out = scrubItem(item("trace", { resourceSpans: [{ scopeSpans: [{ spans: [span] }] }] }));
    const scrubbed = (out.payload as { resourceSpans: { scopeSpans: { spans: (typeof span)[] }[] }[] })
      .resourceSpans[0].scopeSpans[0].spans[0];
    expect(scrubbed).toEqual({
      ...span,
      attributes: [
        { key: "url.full", value: { stringValue: `http://cms.local/members?q=${REDACTED}` } },
        { key: "http.response.status_code", value: { intValue: 303 } },
      ],
    });
  });

  it("doesn't change the item it was given", () => {
    const original = item("log", { message: "jane@example.org" });
    scrubItem(original);
    expect(original.payload).toEqual({ message: "jane@example.org" });
  });
});
