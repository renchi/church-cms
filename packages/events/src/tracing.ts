// Trace context across the outbox and NATS (CMS-29, ADR-0009 addendum).
//
// Inside one process, OpenTelemetry finds "the current span" by itself: Node's
// AsyncLocalStorage carries it through every await. Across HTTP, the
// instrumentation copies it into a `traceparent` header and back. A queue needs
// the same idea done by hand, and the outbox adds a twist:
//
//   request ──► use case ──► outbox row          (inside the HTTP request)
//                               ⋮  up to a second later, on a timer
//                            relay ──► NATS ──► consumer
//
// The relay runs OUTSIDE the request, so by then the request's context is gone
// from memory. The only way to keep the trace together is to write the context
// down next to the event: the `traceparent` column on the outbox row. The relay
// reads it back, publishes as a child of it, and sends its own context as a
// NATS message header. The consumer reads the header and continues the trace.
//
// The W3C traceparent is one short string:
//   00-<trace id: 32 hex>-<parent span id: 16 hex>-<flags: 01 = sampled>
//
// This file only uses @opentelemetry/api. Without an SDK registered (unit tests,
// or a service with tracing off) every call here is a cheap no-op: inject writes
// nothing, extract returns an empty context, and spans are not recorded.
import {
  context,
  propagation,
  ProxyTracerProvider,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Context,
  type Span,
  type SpanOptions,
} from "@opentelemetry/api";

// Headers as a plain object: what we store and what we hand to the NATS client.
export type TraceHeaders = Record<string, string>;

const tracer = trace.getTracer("@cms/events");

// The current context written as headers: `traceparent`, plus `tracestate` if
// an upstream vendor set one.
export function currentTraceHeaders(): TraceHeaders {
  const carrier: TraceHeaders = {};
  propagation.inject(context.active(), carrier);
  return carrier;
}

// The current span's traceparent, to store on an outbox row. null when there is
// no recorded span (tracing off), so the column simply stays empty.
// Only traceparent is stored: `tracestate` carries vendor-specific data (a
// SaaS backend's sampling hints), and nothing in this system sets one. If a
// vendor ever does, store it in a second column and pass both to
// contextFromHeaders; until then it is dropped at the outbox.
export function captureTraceContext(): string | null {
  return currentTraceHeaders().traceparent ?? null;
}

// Rebuilds a context from stored or received headers. Starts from ROOT_CONTEXT,
// not the active one: the relay's timer or the consumer loop must never leak
// into the message's trace. No header (an old row, a message from a publisher
// without tracing) gives a context with no parent, so the span starts a new trace.
export function contextFromHeaders(get: (name: string) => string | undefined): Context {
  const carrier: TraceHeaders = {};
  for (const name of ["traceparent", "tracestate"]) {
    const value = get(name);
    if (value) carrier[name] = value;
  }
  return propagation.extract(ROOT_CONTEXT, carrier);
}

// The same, for a traceparent read back from an outbox row.
export function contextFromTraceparent(traceparent: string | null): Context {
  return contextFromHeaders((name) => (name === "traceparent" ? (traceparent ?? undefined) : undefined));
}

// Runs `work` inside a new span and ends it however `work` finishes. A failure
// is recorded on the span (markFailed) and rethrown. `parent` defaults to the
// active context, so the span nests under whatever is running now.
export async function inSpan<T>(
  name: string,
  options: SpanOptions,
  work: (span: Span) => Promise<T>,
  parent: Context = context.active()
): Promise<T> {
  return tracer.startActiveSpan(name, options, parent, async (span) => {
    try {
      return await work(span);
    } catch (err) {
      markFailed(span, err);
      throw err;
    } finally {
      span.end();
    }
  });
}

// A messaging span (PRODUCER or CONSUMER) that is a child of `parent`. The
// attribute names follow the OTel messaging semantic conventions, so Tempo and
// Grafana recognise them.
export async function inMessagingSpan<T>(
  name: string,
  kind: typeof SpanKind.PRODUCER | typeof SpanKind.CONSUMER,
  parent: Context,
  attributes: { subject: string; messageId?: string },
  work: (span: Span) => Promise<T>
): Promise<T> {
  const messaging = {
    "messaging.system": "nats",
    "messaging.destination.name": attributes.subject,
    ...(attributes.messageId ? { "messaging.message.id": attributes.messageId } : {}),
  };
  return inSpan(name, { kind, attributes: messaging }, work, parent);
}

// The attribute that marks a span as a database query. The sampler
// (sampling.ts) looks for it to drop the outbox relay's background polling.
export const DB_SYSTEM_ATTRIBUTE = "db.system.name";

// One span per database query, named "prisma:<Model>.<action>", e.g.
// "prisma:Member.create". Each service calls it from a Prisma middleware
// (src/infrastructure/prisma.ts); it lives here so the two services' DB spans
// can't drift apart. The middleware runs inside the caller's async context, so
// a query made during a request becomes a child of that request's span; a
// failed query (e.g. a unique violation) marks its span as an error.
export async function inDbSpan<T>(model: string | undefined, action: string, query: () => Promise<T>): Promise<T> {
  const attributes = {
    [DB_SYSTEM_ATTRIBUTE]: "postgresql",
    "db.operation.name": action,
    ...(model ? { "db.collection.name": model } : {}),
  };
  return inSpan(`prisma:${model ?? "raw"}.${action}`, { kind: SpanKind.CLIENT, attributes }, query);
}

// An ERROR status is what TraceQL's `{ status = error }` finds, and what Tempo
// paints red in the waterfall.
export function markFailed(span: Span, err: unknown): void {
  if (err instanceof Error) span.recordException(err);
  span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
}

// Sends any spans still buffered in memory. The SDK exports spans in batches
// every few seconds, so a Pod that exits right after its last request would
// lose that request's spans. Call this during shutdown, after the server has
// closed and before process.exit(). A no-op when tracing is off.
//
// It never rejects and never takes longer than `timeoutMs`: losing the last few
// spans is better than a slow shutdown. With the Collector down, an export can
// hang for the exporter's 10 s timeout (more with retries), and the Pod has
// only terminationGracePeriodSeconds (30) minus the preStop sleep (5) in total
// before the kubelet SIGKILLs it. Returns false when the flush didn't finish.
export async function flushTraces(timeoutMs = 3000): Promise<boolean> {
  // trace.getTracerProvider() is a proxy; the SDK's provider sits behind it.
  const global = trace.getTracerProvider();
  const provider: object = global instanceof ProxyTracerProvider ? global.getDelegate() : global;
  if (!("forceFlush" in provider) || typeof provider.forceFlush !== "function") return true;

  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const flushed = (provider.forceFlush as () => Promise<void>)
    .call(provider)
    .then(() => true, () => false);
  try {
    return await Promise.race([flushed, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}
