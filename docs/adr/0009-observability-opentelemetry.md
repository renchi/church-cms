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
| Logs only via `kubectl logs`                   | Need to search logs across Pods/services   | Loki + Grafana, and trace IDs in log lines                                                    |
| Dashboard only, no alert rules                 | Something must page or notify              | PrometheusRule alerts, routed by Alertmanager (already installed)                             |
