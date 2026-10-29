import { describe, expect, it } from "vitest";
import { context, ROOT_CONTEXT, SpanKind, trace } from "@opentelemetry/api";
import { SamplingDecision } from "@opentelemetry/sdk-trace";
import { serviceSampler } from "./sampling.js";

const sampler = serviceSampler();
// The attributes inDbSpan starts a database span with (tracing.ts).
const DB = { "db.system.name": "postgresql" };
const decide = (name: string, parent = ROOT_CONTEXT, attributes = {}) =>
  sampler.shouldSample(parent, "4bf92f3577b34da6a3ce929d0e0e4736", name, SpanKind.INTERNAL, attributes, []).decision;

describe("serviceSampler", () => {
  it("keeps every new trace that starts with a request or a message", () => {
    expect(decide("POST")).toBe(SamplingDecision.RECORD_AND_SAMPLED);
    expect(decide("process cms.members.archived")).toBe(SamplingDecision.RECORD_AND_SAMPLED);
  });

  it("drops a database span with no parent: the outbox relay's polling", () => {
    expect(decide("prisma:OutboxMessage.findMany", ROOT_CONTEXT, DB)).toBe(SamplingDecision.NOT_RECORD);
  });

  it("goes by the db attribute, not the span name", () => {
    expect(decide("prisma:looks-like-a-query")).toBe(SamplingDecision.RECORD_AND_SAMPLED);
  });

  it("keeps a database span inside a sampled trace", () => {
    const parent = trace.setSpanContext(context.active(), {
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      traceFlags: 1, // sampled
    });
    expect(decide("prisma:Member.create", parent, DB)).toBe(SamplingDecision.RECORD_AND_SAMPLED);
  });
});
