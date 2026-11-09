// rum-smoke.mjs — CMS-30's four acceptance checks, in a real (headless) browser.
// Run it through scripts/rum-smoke.sh, which provides the browser, cms.local and the
// Loki/Tempo port-forwards. docs/observability.md §13 explains each check.
//
//   1. privacy:  no /faro/collect request carries the test member's name, email or phone
//   2. trace:    registering starts a trace whose ROOT span is the browser's
//                (service web-browser), and archiving the same member gives a trace
//                that reaches events-service's consumer
//   3. error:    ?rum-test-error=1 reaches Loki as an exception with page, browser and
//                a stack frame mapped back to a source file (source maps)
//   4. vitals:   Web Vitals measurements reach Loki for /members and /members/new
//
// Why archive for check 2: MemberRegistered has no consumer until CMS-20, so a
// registration's trace ends at the outbox publish. Archiving crosses NATS into
// events-service, the same choice CMS-29 made for its trace check.
//
// Exits 0 when every check passes, 1 otherwise; prints one ✔/✘ line per check.

import { chromium, devices } from "playwright";

const BASE = process.env.BASE_URL ?? "http://cms.local";
const LOKI = process.env.LOKI_URL ?? "http://localhost:13100";
const TEMPO = process.env.TEMPO_URL ?? "http://localhost:13200";

// A unique, recognisable test member: if any of these strings shows up in telemetry,
// the privacy check fails. The phone is checked as typed and as bare digits.
const tag = Date.now().toString().slice(-6);
const member = {
  name: `Rum Smoke ${tag}`,
  email: `rum-smoke-${tag}@example.org`,
  phone: `+44 7700 9${tag.slice(0, 5)}`,
};
const personal = [member.name, member.email, member.phone, member.phone.replace(/\D/g, "")];

let failed = false;
const ok = (msg) => console.log(`  \x1b[32m✔\x1b[0m ${msg}`);
const fail = (msg) => {
  failed = true;
  console.log(`  \x1b[31m✘\x1b[0m ${msg}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Poll until fn returns something truthy, or give up after `seconds`.
async function waitFor(seconds, fn) {
  for (let i = 0; i < seconds; i++) {
    const value = await fn().catch(() => null);
    if (value) return value;
    await sleep(1000);
  }
  return null;
}

async function lokiLines(query, minutes = 15) {
  const url = new URL("/loki/api/v1/query_range", LOKI);
  url.searchParams.set("query", query);
  url.searchParams.set("start", String((Date.now() - minutes * 60_000) * 1e6));
  url.searchParams.set("limit", "500");
  const body = await (await fetch(url)).json();
  return body.data.result.flatMap((stream) => stream.values.map(([, line]) => line));
}

async function tempoTrace(traceId) {
  const res = await fetch(new URL(`/api/traces/${traceId}`, TEMPO));
  if (!res.ok) return null;
  const body = await res.json();
  // Tempo returns OTLP JSON: batches (one per resource/service) → spans.
  return body.batches.flatMap((b) => {
    const service = b.resource.attributes.find((a) => a.key === "service.name")?.value.stringValue;
    return (b.scopeSpans ?? b.instrumentationLibrarySpans ?? []).flatMap((s) =>
      s.spans.map((span) => ({ service, name: span.name, parent: span.parentSpanId ?? "" }))
    );
  });
}

// The trace id of the browser's span for the Server Action POST on `path`, read from
// the Faro payloads the page sent (traces are OTLP JSON inside them). The path must
// match exactly: "contains /members" would also match /members/new.
function serverActionTraceId(bodies, path) {
  for (const body of bodies) {
    for (const rs of body.traces?.resourceSpans ?? []) {
      for (const ss of rs.scopeSpans ?? []) {
        for (const span of ss.spans ?? []) {
          const attr = (k) => span.attributes?.find((a) => a.key === k)?.value?.stringValue ?? "";
          const method = attr("http.method") || attr("http.request.method");
          const url = attr("http.url") || attr("url.full");
          if (method === "POST" && url && new URL(url).pathname === path) return span.traceId;
        }
      }
    }
  }
  return null;
}

const browser = await chromium.launch();
// A phone: the app is mobile-first, and the acceptance criterion says phone-sized.
const context = await browser.newContext({ ...devices["Pixel 7"] });
const page = await context.newPage();

// Record every telemetry request the page makes, and every answer the receiver gives.
// A rejected batch is invisible in the browser (Faro doesn't retry or complain), so
// the test counts it: in CMS-30 every batch holding a span got HTTP 400 for a while.
const bodies = [];
const raw = [];
const rejected = [];
page.on("response", (res) => {
  if (res.url().includes("/faro/collect") && res.status() >= 300) rejected.push(res.status());
});
page.on("request", (req) => {
  if (!req.url().includes("/faro/collect")) return;
  const text = req.postData() ?? "";
  raw.push(text);
  try {
    bodies.push(JSON.parse(text));
  } catch {
    // Not JSON (shouldn't happen); the raw text is still checked for personal data.
  }
});

console.log(`RUM smoke test against ${BASE} as a ${devices["Pixel 7"].viewport.width}×${devices["Pixel 7"].viewport.height} phone`);

// Register, as a user would.
await page.goto(`${BASE}/members/new`);
await page.fill('input[name="name"]', member.name);
await page.fill('input[name="email"]', member.email);
await page.fill('input[name="phone"]', member.phone);
await Promise.all([page.waitForURL(/\/members\?registered=/), page.click('button[type="submit"]')]);
const memberId = new URL(page.url()).searchParams.get("registered");

// Browser spans are batched: OpenTelemetry's BatchSpanProcessor sends every ~5 s, and a
// full page navigation before then loses the queue. Real users do that too (a reason
// RUM data is always a little incomplete); the test waits, so it can check the trace.
const SPAN_BATCH_MS = 6000;
await sleep(SPAN_BATCH_MS);

// Archive the same member from the list (the list also SHOWS name, email and phone:
// none of it may end up in telemetry).
await page.waitForSelector(`form:has(input[name="id"][value="${memberId}"]) button`);
await page.click(`form:has(input[name="id"][value="${memberId}"]) button`);
await page.waitForSelector(`form:has(input[name="id"][value="${memberId}"])`, { state: "detached", timeout: 10_000 }).catch(() => {});
await sleep(SPAN_BATCH_MS);

// The deliberate browser error (needs rum.debug in the chart).
await page.goto(`${BASE}/members/new?rum-test-error=1`);
await sleep(1500);

// Faro sends Web Vitals (LCP, CLS, INP) when a page is hidden; closing the page
// hides it, which flushes everything still queued.
await page.goto(`${BASE}/members`);
await sleep(1000);
await page.close({ runBeforeUnload: true });
await sleep(2000);
await context.close();
await browser.close();

if (raw.length === 0) {
  fail("no /faro/collect requests at all: is rum.enabled on, and is the Faro ingress applied?");
  process.exit(1);
}
if (rejected.length) fail(`${rejected.length} of ${raw.length} telemetry requests were rejected (HTTP ${[...new Set(rejected)].join(", ")}): check \`kubectl -n monitoring logs ds/alloy\``);
else ok(`${raw.length} telemetry requests, all accepted by the receiver`);

// 1. Privacy.
const leaks = personal.filter((value) => raw.some((text) => text.includes(value)));
if (leaks.length) fail(`telemetry contains personal data: ${leaks.join(", ")}`);
else ok("no name, email or phone in any telemetry request");

// 2. Traces.
const registerTrace = serverActionTraceId(bodies, "/members/new");
const archiveTrace = serverActionTraceId(bodies, "/members");
for (const [label, traceId, mustReach] of [
  ["registration", registerTrace, "members-service"],
  ["archive", archiveTrace, "events-service"],
]) {
  if (!traceId) {
    fail(`${label}: no browser span for the Server Action POST in the Faro payloads`);
    continue;
  }
  const spans = await waitFor(60, async () => {
    const s = await tempoTrace(traceId);
    return s && s.some((x) => x.service === mustReach) ? s : null;
  });
  if (!spans) {
    fail(`${label}: trace ${traceId} didn't reach ${mustReach} in Tempo within 60 s`);
    continue;
  }
  const roots = spans.filter((s) => !s.parent);
  const services = [...new Set(spans.map((s) => s.service))].join(" → ");
  if (roots.length === 1 && roots[0].service === "web-browser") {
    ok(`${label}: one trace, root "${roots[0].name}" in the browser, services ${services}`);
  } else {
    fail(`${label}: root span(s) ${roots.map((r) => `${r.service}/${r.name}`).join(", ") || "none"}, expected one in web-browser`);
  }
}

// 3. The error, with page, browser and a source-mapped stack.
const errorLine = await waitFor(60, async () => {
  const lines = await lokiLines('{app="web-browser", kind="exception"} |= "RUM test error"');
  return lines[0] ?? null;
});
if (!errorLine) fail("the test error didn't reach Loki within 60 s (is rum.debug on?)");
else {
  const has = (re) => re.test(errorLine);
  const missing = [
    ["page", /page_id=\/members\/new/],
    ["browser", /browser_name=/],
    // A real version, not "[redacted]": an over-eager scrubber once took it (review, CMS-30).
    ["browser version", /browser_version=(?!"?\[redacted\])\S/],
    ["source-mapped stack", /stacktrace=.*\.tsx/s],
  ].filter(([, re]) => !has(re));
  if (missing.length) fail(`test error in Loki, but missing: ${missing.map(([m]) => m).join(", ")}\n      ${errorLine.slice(0, 400)}`);
  else ok("test error in Loki with page, browser and a source-mapped stack trace");
}

// 4. Web Vitals for both pages.
for (const pageIdValue of ["/members", "/members/new"]) {
  const line = await waitFor(60, async () => {
    const lines = await lokiLines(`{app="web-browser", kind="measurement"} | logfmt | type="web-vitals" | page_id="${pageIdValue}"`);
    return lines[0] ?? null;
  });
  if (line) ok(`Web Vitals in Loki for ${pageIdValue}`);
  else fail(`no Web Vitals in Loki for ${pageIdValue} within 60 s`);
}

process.exit(failed ? 1 : 0);
