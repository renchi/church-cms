// @cms/events: the one package both bounded contexts may import (ADR-0010).
//   contract.ts    — what travels over NATS: subjects, wire types, parsers
//   nats.ts        — connecting, and declaring streams and durable consumers
//   outboxRelay.ts — publishing saved outbox rows (the transactional outbox)
//   consumer.ts    — receiving messages and answering ack / nak / term
export * from "./contract.js";
export * from "./nats.js";
export * from "./outboxRelay.js";
export * from "./consumer.js";
