# ADR-0009 — Observability: OpenTelemetry instrumentation, Prometheus + Grafana backend

**Date:** October 2026
**Status:** Accepted
**Linear:** CMS-24
**Context:** How services expose metrics and logs, and what collects and shows them

---

## Context

ADR-0007 added observability as roadmap stage 7: "Prometheus + Grafana on minikube".
The CMS-24 ticket suggested a Fastify Prometheus plugin for the `/metrics` endpoint.

There are two separate choices here:

- **Instrumentation:** the code inside each service that measures requests.
- **Backend:** the systems that collect, store and display those measurements.

A Prometheus-specific plugin ties the two together: if the backend ever changes,
every service's instrumentation changes too. **OpenTelemetry (OTel)** is the
vendor-neutral standard for the instrumentation side. It's what most tools now
accept, and it covers all three signals (metrics, logs, traces) with one SDK.

Only members-service exists today. Events comes at stage 8, and NATS at stage 9.

---

## Decision

**Instrument with the OpenTelemetry SDK. Keep Prometheus + Grafana as the backend.**

- Each service preloads `src/instrumentation.ts` (`node --import`). It starts the OTel
  Node SDK with:
  - `@opentelemetry/instrumentation-http`, which records the
    `http.server.request.duration` histogram (stable semantic conventions)
  - `@fastify/otel`, which adds the matched route template (`http.route`)
  - a **Prometheus exporter** that serves `/metrics` on its own port (9464)
- Prometheus (kube-prometheus-stack) **pulls** from that port, using a ServiceMonitor
  in each service's Helm chart.
- Grafana shows one shared RED dashboard (rate, errors, duration) with a per-service
  dropdown.
- Logs are pino JSON on stdout, read with `kubectl logs`.

**Deferred** until the Events service exists (stage 8/9):

- the **OTel Collector** and OTLP push
- **traces**, with a trace backend (Tempo or Jaeger)
- trace IDs injected into log lines
- a log aggregator (Loki)

Tracing pays off when a request crosses a service boundary or a message bus. With
one service, a trace is a single Fastify span, which teaches little and adds two
more components to run.

---

## Consequences

**Good**

- Industry-standard instrumentation. The same code can later feed any backend.
- Adding traces later is a configuration change in `instrumentation.ts` (an exporter),
  not a rewrite of the services.
- Metric names and labels follow OTel semantic conventions, so they're portable
  across tools and docs.
- `/metrics` sits on a separate port that the public Ingress never routes to.

**Costs**

- More moving parts than a single Fastify plugin: the SDK, two instrumentations and
  an exporter.
- ESM needs care: the SDK must load before `http` and `fastify`, so it's preloaded
  with `--import`, and the Fastify plugin is registered explicitly in `buildApp()`.
- The Prometheus Operator's CRDs must exist before a chart with
  `metrics.serviceMonitor.enabled=true` can install. The monitoring stack is a
  one-time manual install (`docs/observability.md`), like Traefik.

## Evolution path

| Now                                            | Trigger                                    | Then                                                                                          |
| ---------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------- |
| Prometheus exporter in each service (pull)     | Traces wanted / Events service + NATS live | Add OTLP exporters → an OTel Collector, which exports metrics to Prometheus and traces to Tempo |
| ~~Logs only via `kubectl logs`~~ Done (CMS-28, addendum below) | Need to search logs across Pods/services   | Loki + Grafana (done); trace IDs in log lines still deferred to tracing                        |
| Dashboard only, no alert rules                 | Something must page or notify              | PrometheusRule alerts, routed by Alertmanager (already installed)                             |

---

## Addendum (CMS-28, October 2026): centralised logs with Loki + Alloy

**Status:** Accepted

The trigger in the evolution path above, "need to search logs across Pods/services",
was met once Events and NATS went live: one member registration now touches web,
members-service, the outbox relay and Traefik, and `kubectl logs` shows one Pod at a
time and loses a deleted Pod's lines. This addendum takes the **logs** half of the
path. Traces, and trace IDs in log lines, stay deferred (CMS-29).

### Decision

- **Store:** Loki (chart `grafana-community/loki`, the open-source chart's home since
  March 2026) in **monolithic / single-binary** mode, **filesystem** storage on a 2 Gi
  PVC, **7-day retention** applied by the compactor. No gateway, no memcached caches,
  no canary: on a 6 GB minikube they would cost more memory than Loki itself.
- **Shipper:** **Grafana Alloy** as a DaemonSet that tails `/var/log/pods` on its node
  and pushes to Loki. Alloy is Grafana's distribution of the OpenTelemetry Collector,
  so the tracing work (CMS-29) can reuse the same agent. Promtail is deprecated; the
  upstream OTel Collector is weaker at tailing Pod log files.
- **Labels (the Loki index):** only `namespace`, `pod`, `container` and `app` (from
  `app.kubernetes.io/name`, falling back to the `app` Pod label). Everything per
  request (`reqId`, `memberId`, `level`, `service`) stays in the JSON line and is read
  with `| json` at query time. High-cardinality labels would multiply Loki's streams.
- **Kubernetes events** go to Loki through the same Alloy DaemonSet
  (`loki.source.kubernetes_events`). Correct on one node; on more nodes every event
  would be stored once per node, so that needs a separate one-replica Alloy, or
  Alloy clustering.
- **Log lines:** pino levels are written as words (`"level":"error"`). Business
  events get their own lines: members-service logs `member registered` with only
  the `memberId` (no personal data) in the API layer, where `req.log` carries the
  request's `reqId`, and web logs `registration succeeded|failed` through a small
  JSON helper. Traefik writes JSON access logs, without headers.
- **Correlation across services is by `memberId`.** `reqId` is per process and only
  links lines inside one service. Propagating a request or trace ID across services
  is tracing, which is CMS-29.

### Consequences

**Good:** every Pod's logs, including deleted Pods', are searchable in Grafana next
to the RED metrics, and one registration can be followed across web, members-service
and Traefik. Loki + Alloy fit in about 500 MB.

**Costs:** two more components to run and upgrade. Single-binary Loki on a
filesystem has no redundancy: losing the PVC loses the logs, which is acceptable
for a learning cluster. Queries that skip labels (only `|= "text"`) scan every
chunk in the time range, so they get slower as volume grows.

| Now (after this addendum)                      | Trigger                                  | Then                                                       |
| ---------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------- |
| Loki single-binary, filesystem                 | More volume than one process handles, or HA | Simple-scalable/distributed Loki on object storage (S3/MinIO) |
| Alloy DaemonSet also collects Kubernetes events | More than one node                       | A separate one-replica Alloy for events, or Alloy clustering |
| Correlation by `memberId`; `reqId` per service | Following one request across services    | OTel traces; `trace_id` in every log line (CMS-29)         |
