// The trace must survive the outbox and NATS: the relay's PRODUCER span is a
// child of the request that wrote the row, and the consumer's CONSUMER span is
// a child of the producer. These tests register a real (in-memory) tracer, so
// they check the actual parent ids, not just that some function was called.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { context, propagation, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";
import { handleMessage, type AckableMessage } from "./consumer.js";
import { parseMemberArchived } from "./contract.js";
import { startOutboxRelay, type OutboxBatch, type OutboxRow, type OutboxStore } from "./outboxRelay.js";
import { captureTraceContext, type TraceHeaders } from "./tracing.js";

const exporter = new InMemorySpanExporter();
const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
const contextManager = new AsyncLocalStorageContextManager();

// What a service's instrumentation.ts does through the NodeSDK, done by hand.
beforeAll(() => {
  trace.setGlobalTracerProvider(provider);
  context.setGlobalContextManager(contextManager.enable());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
});
afterAll(() => {
  trace.disable();
  context.disable();
  propagation.disable();
});
beforeEach(() => exporter.reset());

// The span processor hands spans to the exporter asynchronously, so flush first.
async function finishedSpans() {
  await provider.forceFlush();
  return exporter.getFinishedSpans();
}

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const REQUEST_SPAN_ID = "00f067aa0ba902b7";
const TRACEPARENT = `00-${TRACE_ID}-${REQUEST_SPAN_ID}-01`;

function storeWith(row: OutboxRow): OutboxStore {
  const batch: OutboxBatch = {
    fetchPending: async () => [row],
    markPublished: async () => {},
  };
  return { runExclusive: async (work) => work(batch) };
}

function fakeMessage(headers: TraceHeaders): AckableMessage {
  return {
    subject: "cms.members.archived",
    info: { deliveryCount: 1, streamSequence: 1 },
    headers: { get: (name) => headers[name] ?? "" }, // MsgHdrs returns "" when missing
    json: <T>() =>
      ({ id: "msg-1", type: "MemberArchived", version: 1, occurredAt: "2026-10-29T10:00:00.000Z", data: { memberId: "m-1" } }) as T,
    ack: vi.fn(),
    nak: vi.fn(),
    term: vi.fn(),
  };
}

describe("captureTraceContext", () => {
  it("returns the active span's traceparent, to store on the outbox row", () => {
    const span = provider.getTracer("test").startSpan("request");
    const stored = context.with(trace.setSpan(context.active(), span), () => captureTraceContext());
    span.end();
    expect(stored).toBe(`00-${span.spanContext().traceId}-${span.spanContext().spanId}-01`);
  });

  it("returns null outside any span (tracing off, or a background job)", () => {
    expect(captureTraceContext()).toBeNull();
  });
});

describe("outbox relay", () => {
  it("publishes inside a PRODUCER span that is a child of the stored traceparent, and sends its own context", async () => {
    const publish = vi.fn().mockResolvedValue(undefined);
    const relay = startOutboxRelay({
      store: storeWith({ id: "row-1", subject: "cms.members.archived", payload: {}, traceparent: TRACEPARENT }),
      publish,
      log,
      autoStart: false,
    });
    await relay.runOnce();

    const [span] = await finishedSpans();
    expect(span.name).toBe("publish cms.members.archived");
    expect(span.kind).toBe(SpanKind.PRODUCER);
    expect(span.spanContext().traceId).toBe(TRACE_ID); // same trace as the request
    expect(span.parentSpanContext?.spanId).toBe(REQUEST_SPAN_ID);
    expect(span.attributes["messaging.message.id"]).toBe("row-1");
    // The header names the PRODUCER span as the parent, so the consumer nests under it.
    const headers = publish.mock.calls[0][3] as TraceHeaders;
    expect(headers.traceparent).toBe(`00-${TRACE_ID}-${span.spanContext().spanId}-01`);
  });

  it("starts a new trace for a row written without tracing", async () => {
    const relay = startOutboxRelay({
      store: storeWith({ id: "row-2", subject: "cms.members.archived", payload: {}, traceparent: null }),
      publish: vi.fn().mockResolvedValue(undefined),
      log,
      autoStart: false,
    });
    await relay.runOnce();
    const [span] = await finishedSpans();
    expect(span.parentSpanContext).toBeUndefined();
  });
});

describe("handleMessage", () => {
  it("handles the message inside a CONSUMER span that is a child of the traceparent header", async () => {
    let activeInHandler: string | undefined;
    await handleMessage(
      fakeMessage({ traceparent: TRACEPARENT }),
      parseMemberArchived,
      async () => {
        activeInHandler = trace.getActiveSpan()?.spanContext().spanId;
      },
      log
    );

    const [span] = await finishedSpans();
    expect(span.name).toBe("process cms.members.archived");
    expect(span.kind).toBe(SpanKind.CONSUMER);
    expect(span.spanContext().traceId).toBe(TRACE_ID);
    expect(span.parentSpanContext?.spanId).toBe(REQUEST_SPAN_ID);
    // The use case runs inside the span, so its database spans become children.
    expect(activeInHandler).toBe(span.spanContext().spanId);
  });

  it("marks the span as an error when the handler fails (the message is nak'd)", async () => {
    const msg = fakeMessage({ traceparent: TRACEPARENT });
    await handleMessage(msg, parseMemberArchived, async () => Promise.reject(new Error("db down")), log);

    const [span] = await finishedSpans();
    expect(msg.nak).toHaveBeenCalled();
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.status.message).toBe("db down");
  });

  it("starts a new trace when the header is missing", async () => {
    await handleMessage(fakeMessage({}), parseMemberArchived, async () => {}, log);
    const [span] = await finishedSpans();
    expect(span.parentSpanContext).toBeUndefined();
  });
});
