// Which traces the services keep (CMS-29). Shared by members-service and
// events-service so the two can't drift apart: if one sampled differently, a
// registration's trace could arrive in Tempo with half its spans missing.
//
// This is HEAD sampling: the decision is made when a trace's first span starts,
// then travels with it (the `01` flag at the end of the traceparent), so every
// service keeps or drops the same trace.
//   - ParentBased: a span with a parent follows the parent's decision. A trace
//     that web sampled stays whole here.
//   - root: a span with NO parent (a new trace) asks the sampler below. We keep
//     all of them (100%, fine for a learning cluster), except one kind of noise:
//     database spans with no parent. The outbox relay polls the database every
//     second and every Pod runs it, so without this filter Tempo would fill up
//     with "prisma:OutboxMessage.findMany" traces that belong to no request.
// In production you'd keep, say, 10% of root traces (TraceIdRatioBasedSampler)
// or use TAIL sampling in the Collector: wait for the whole trace, then keep all
// errors and slow ones. Tail sampling can see the outcome; head sampling can't.
import { ParentBasedSampler, SamplingDecision, type Sampler } from "@opentelemetry/sdk-trace";
import { DB_SYSTEM_ATTRIBUTE } from "./tracing.js";

// A database span is recognised by its `db.system.name` attribute (set by
// inDbSpan in tracing.ts), not by its name: the attributes a span starts with
// are handed to the sampler, and they don't change if the naming does.
const dropBackgroundQueries: Sampler = {
  shouldSample: (_context, _traceId, _spanName, _spanKind, attributes) => ({
    decision:
      attributes[DB_SYSTEM_ATTRIBUTE] !== undefined ? SamplingDecision.NOT_RECORD : SamplingDecision.RECORD_AND_SAMPLED,
  }),
  toString: () => "DropBackgroundQueries",
};

export function serviceSampler(): Sampler {
  return new ParentBasedSampler({ root: dropBackgroundQueries });
}
