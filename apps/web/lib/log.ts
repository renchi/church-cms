// One structured JSON log line on stdout, for code that runs on the web Pod
// (Server Actions, Server Components). Never import this into a Client Component:
// in the browser it would log to the user's console, not to Loki.
//
// Why not pino, like the services? The web app logs a handful of events
// (registration succeeded / failed, the member list failing to load), so one
// function is clearer than a dependency. It behaves like the services' pino
// setup where it matters for Loki:
//   - the same shape: `level` as a word, `time`, `service`, `msg`, so the same
//     LogQL works across all three apps: `| json | level="error"`;
//   - LOG_LEVEL from the chart (charts/web/values.yaml → config.logLevel), so
//     setting it to `warn` quiets web too, and a `debug` line stays silent in
//     production;
//   - Error objects become { type, message }; JSON.stringify would print {}.
//
// Trace ids (CMS-29): while a request is being traced, every line also carries
// `trace_id` and `span_id`, the same keys PinoInstrumentation adds to the
// services' lines. Grafana turns a trace_id in a Loki line into a link to the
// trace in Tempo. Without tracing (no span active) the keys are left out.
//
// The production Next.js server (`next start`) logs nothing about requests by
// itself, so without lines like these the web hop is invisible in Loki.
// Alloy reads them from the container's stdout (study-guide §9.9).

import { trace } from "@opentelemetry/api";

export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold(): number {
  const configured = process.env.LOG_LEVEL as LogLevel | undefined;
  return ORDER[configured ?? "info"] ?? ORDER.info;
}

function serialise(value: unknown): unknown {
  return value instanceof Error ? { type: value.name, message: value.message } : value;
}

export function logEvent(level: LogLevel, fields: Record<string, unknown>, msg: string): void {
  if (ORDER[level] < threshold()) return;
  const extra = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, serialise(v)]));
  // The fixed keys come last, so a field can't overwrite them: a stray
  // { level: "info" } must not hide an error from `level="error"` queries.
  const spanContext = trace.getActiveSpan()?.spanContext();
  const ids = spanContext ? { trace_id: spanContext.traceId, span_id: spanContext.spanId } : {};
  const line = { ...extra, ...ids, level, time: Date.now(), service: "web", msg };
  console.log(JSON.stringify(line));
}
