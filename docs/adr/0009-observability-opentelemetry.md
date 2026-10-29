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
| ~~Prometheus exporter only~~ Traces done (CMS-29, addendum below); metrics still pulled | Traces wanted / Events service + NATS live | OTLP → an OTel Collector → Tempo (done); metrics onto the Collector still deferred |
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

---

## Addendum (CMS-29, October 2026): distributed tracing with the OTel Collector + Tempo

**Status:** Accepted

The first row of the evolution path above, "traces wanted / Events service + NATS live",
has fired: one member registration now crosses web, members-service, Postgres, the outbox
relay, NATS and events-service. CMS-28 could only follow it by `memberId`, and a failed
request (a duplicate email, `409`) has no `memberId` at all. This addendum adds the
**traces** pillar.

### Decision

- **Pipeline: apps → OTel Collector → Tempo.** Every app pushes spans over OTLP/HTTP to
  one **upstream OpenTelemetry Collector** (`open-telemetry/opentelemetry-collector`,
  contrib image, one-replica Deployment, [`otel-collector-values.yaml`](../../k8s/monitoring/otel-collector-values.yaml)).
  The Collector batches them and forwards them to **Tempo** over OTLP/gRPC. The apps
  know only the Collector's address, so changing the trace backend is a Collector config
  change, not an app change.
- **The upstream Collector, not Alloy.** Alloy (CMS-28) is a Collector distribution and
  could have taken this job. We chose the upstream Collector because its YAML config is
  the one most docs and vendors use. Alloy's config language is Grafana-specific. The
  price is one more Pod (~100 MB).
- **Tempo single-binary** (`grafana-community/tempo`; the chart moved there along with Loki's),
  filesystem storage on a 2 Gi PVC, **24h retention**. No object storage, no
  distributed mode.
- **Instrumentation.** members-service and events-service add a trace pipeline to their
  existing `NodeSDK` (`src/instrumentation.ts`): HTTP and Fastify spans (already
  instrumented for metrics), a span per database query from a small Prisma middleware
  (`src/infrastructure/prisma.ts`), and `instrumentation-pino` for `trace_id`/`span_id`
  in log lines. The official `@prisma/instrumentation` was tried first: its Prisma 5
  release builds spans with the 1.x SDK and crashed every query against our 2.x SDK.
  Switch back to it when Prisma is upgraded to 6+. The Prometheus metrics exporter is unchanged. web uses `@vercel/otel` in
  `instrumentation.ts`. Its `fetch` sends `traceparent` only to `MEMBERS_API_URL`
  (`propagateContextUrls`; the default is Vercel URLs only).
- **Off by default.** Each chart has `tracing.otlpEndpoint` (default `""`), which sets
  `OTEL_TRACES_EXPORTER=otlp|none` and `OTEL_EXPORTER_OTLP_ENDPOINT`. `deploy.yml` and
  `cluster-up.sh` turn it on.
- **Trace context through the outbox and NATS.** In-process, AsyncLocalStorage carries the
  context; across HTTP, the `traceparent` header does. The outbox relay publishes *later*,
  outside the request, so the context is **stored**: a nullable `traceparent` column on
  `OutboxMessage` in both services, written with the row. The relay publishes inside a
  **PRODUCER** span that is a child of the stored context, and sends its own context as a
  NATS **message header**, never in the payload: the payload is the domain contract, and
  trace context is transport metadata. The consumer starts a **CONSUMER** span as a
  **child** of that header (`@cms/events` `tracing.ts`). We chose child over **span link**
  because one message has one cause, and the acceptance test is *one* trace. Links suit
  batch consumers, where one span handles many messages from many traces.
- **Sampling: head-based, 100%,** shared by both services (`@cms/events` `sampling.ts`). `ParentBased` with a root sampler that keeps every new
  trace except Prisma spans with no parent: the outbox relay's once-a-second polling,
  which belongs to no request and would otherwise flood Tempo. In production you'd keep a
  ratio of root traces, or **tail-sample** in the Collector (keep every error and slow
  trace, a fraction of the rest). That needs the whole trace in one Collector, so it's
  deferred.
- **Exemplars from span metrics.** The apps' Prometheus exporter can't attach exemplars,
  so the Collector's **spanmetrics** connector derives a latency histogram from the spans,
  with trace ids attached, and serves it for Prometheus to scrape (OpenMetrics format,
  `exemplar-storage` turned on in Prometheus). One new RED dashboard panel reads it.
- **Grafana links:** Loki `derivedFields` turns `"trace_id":"…"` in a line into a link to
  Tempo; Tempo `tracesToLogsV2` opens a span's logs in Loki; Prometheus
  `exemplarTraceIdDestinations` opens an exemplar's trace.
- A manual span around `RegisterMemberUseCase` is started in the **API layer**, like the
  business log line, so the application layer stays free of telemetry. A rejected rule
  marks it as an error. The HTTP server span only counts 5xx as errors (OTel semantic
  conventions), so without this span a `409` would not be findable with `{ status = error }`.

### Consequences

**Good:** one trace shows an archive from the Server Action (the members list's Archive
button) to the events-service consumer, and a registration through to its `publish`
(`MemberRegistered` has no consumer until CMS-20), failed requests included. Log lines and traces link both ways, and a slow point
on a graph opens the request that caused it. The services' instrumentation now covers all
three signals with one SDK.

**Costs:** two more components (Collector, Tempo). The OTel packages must move together:
`instrumentation-pino` is pinned to 0.69 because 0.70 moved to the OTel 3.x line.
The Prisma middleware (`$use`) is deprecated in favour of client extensions, and shows
query spans only, not the engine's own (connection, SQL). One more column per outbox row. Span metrics count only *sampled* spans: at 100%
that's exact, at a lower rate it's a sample.

| Now (after this addendum) | Trigger | Then |
| --- | --- | --- |
| Head sampling at 100% | Trace volume or Tempo storage matters | Ratio sampling of root traces, or tail sampling in the Collector (keep errors + slow) |
| Metrics pulled from each app; logs via Alloy; only traces through the Collector | Want one pipeline to configure, or a backend that wants OTLP for everything | Metrics and logs onto the Collector too (OTLP push) |
| Tempo single-binary on a filesystem | More traffic, or HA | Distributed Tempo on object storage |
| Server-side spans only; the trace starts at the Server Action | Need to see what the user waited for in the browser | Browser RUM with Grafana Faro (CMS-30) |
| Consumer span is a child of the producer | A consumer that handles messages in batches | Span links, one per message |
