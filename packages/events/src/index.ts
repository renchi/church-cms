// @cms/events: the one package both bounded contexts may import (ADR-0010).
// Mostly messaging; tracing.ts and sampling.ts are here because the services'
// telemetry must match on both sides of NATS (CMS-29). If telemetry grows
// beyond that, it belongs in a package of its own.
//   contract.ts    — what travels over NATS: subjects, wire types, parsers
//   nats.ts        — connecting, and declaring streams and durable consumers
//   outboxRelay.ts — publishing saved outbox rows (the transactional outbox)
//   consumer.ts    — receiving messages and answering ack / nak / term
//   tracing.ts     — carrying the trace context through the outbox and NATS
//   sampling.ts    — which traces the services keep
export * from "./contract.js";
export * from "./nats.js";
export * from "./outboxRelay.js";
export * from "./consumer.js";
export * from "./tracing.js";
export * from "./sampling.js";
