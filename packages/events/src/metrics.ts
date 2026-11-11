// Business metrics for the messaging plumbing (CMS-31): what the outbox and the
// consumers are doing, in numbers Prometheus can graph and alert on.
//
// Both services run the same relay and consumer code, so the metrics live here,
// next to it, and come out the same on both sides. Each service's OTel SDK
// (src/instrumentation.ts) exports them on :9464/metrics with the HTTP metrics.
// OTel names use dots; the Prometheus exporter turns them into underscores and
// adds `_total` to counters. It does NOT add the unit (seconds), like
// http_server_request_duration, so the unit is in each description instead:
//   outbox.published          → outbox_published_total
//   outbox.publish.delay      → outbox_publish_delay_{bucket,sum,count}   (seconds)
//   outbox.rows               → outbox_rows
//   outbox.oldest_pending.age → outbox_oldest_pending_age                 (seconds)
//   messages.consumed         → messages_consumed_total
// Every series also gets otel_scope_name="@cms/events" (the meter's name).
//
// LABELS (attributes) must have a small, fixed set of values. Every distinct
// combination is a separate time series that Prometheus keeps in memory, so a
// label like `messageId` or `memberId` would create one series per message and
// eventually exhaust it. Here: `subject` (a handful of NATS subjects), `state`
// (2 values), `outcome` (about 5). Ids belong in logs and traces, not metrics.
import { metrics, type Counter, type Histogram, type Meter, type ObservableGauge } from "@opentelemetry/api";

export interface MessagingInstruments {
  meter: Meter;
  published: Counter;
  publishDelay: Histogram;
  outboxRows: ObservableGauge;
  oldestPendingAge: ObservableGauge;
  consumed: Counter;
}

let instruments: MessagingInstruments | undefined;

// Created on first use, not when this file is imported. The OTel API has no
// "placeholder" meter that upgrades later (tracing has one, metrics doesn't):
// a meter taken before the SDK is registered stays a no-op forever. In the
// services the SDK starts first (it's preloaded), but tests register theirs
// after the imports, so creating the instruments lazily works for both.
export function messagingInstruments(): MessagingInstruments {
  if (instruments) return instruments;
  const meter = metrics.getMeter("@cms/events");
  instruments = {
    meter,
    // A COUNTER only goes up. Prometheus stores the running total; `rate()` or
    // `increase()` turns it into "per second" or "in the last hour", and both
    // cope with the total dropping back to 0 when a Pod restarts.
    published: meter.createCounter("outbox.published", {
      description: "Outbox rows published to NATS, by subject",
    }),
    // A HISTOGRAM counts values into buckets (how many took ≤1 s, ≤5 s, ...).
    // This one measures how long an event waited in the outbox: from the moment
    // the use case saved it to the moment NATS stored it. It backs the SLO
    // "99% of MemberRegistered events leave the outbox in under 30 s"
    // (k8s/monitoring/slo-rules.yaml), which needs a bucket edge at exactly 30.
    // Normally ~1 s (the relay polls every second); minutes when NATS is down.
    publishDelay: meter.createHistogram("outbox.publish.delay", {
      description: "Time from saving an event in the outbox to publishing it",
      unit: "s",
      advice: { explicitBucketBoundaries: [0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600] },
    }),
    // GAUGES report a current value ("how many right now"), read when Prometheus
    // scrapes (an OBSERVABLE gauge calls back into our code to get it). These two
    // come from the outbox TABLE, not from memory, so they survive restarts: the
    // table is the durable record of what was saved and what was published.
    outboxRows: meter.createObservableGauge("outbox.rows", {
      description: "Rows in the outbox table, by subject and state (pending | published)",
    }),
    oldestPendingAge: meter.createObservableGauge("outbox.oldest_pending.age", {
      description: "Age of the oldest unpublished outbox row (0 when none): the relay's lag",
      unit: "s",
    }),
    // One count per message handled, by what happened to it:
    //   applied, duplicate, ... — the handler's own answer (it returns one)
    //   rejected — terminated: it can never be processed (bad JSON, bad version)
    //   retried  — failed this time, redelivered later (e.g. the database is down)
    consumed: meter.createCounter("messages.consumed", {
      description: "Messages handled by this service's consumer, by subject and outcome",
    }),
  };
  return instruments;
}

// For tests that install a fresh MeterProvider: forget the old instruments.
export function resetMessagingInstruments(): void {
  instruments = undefined;
}
