-- CMS-29 (ADR-0009 addendum): distributed tracing through the outbox.
--
-- The outbox relay publishes a row up to a second after the request that wrote
-- it, on its own timer. By then that request's trace context is gone from
-- memory (it lived in AsyncLocalStorage for the length of the request), so it
-- has to be written down with the event. The relay reads it back, publishes as
-- a child of it, and sends its own context to NATS as a `traceparent` header.
--
-- Nullable, and no backfill: older rows simply start a new trace when published.
-- A W3C traceparent is short and fixed in shape:
--   00-<32 hex trace id>-<16 hex parent span id>-<2 hex flags>

-- AlterTable
ALTER TABLE "OutboxMessage" ADD COLUMN "traceparent" TEXT;
