// OpenTelemetry bootstrap: metrics (CMS-24) and traces (CMS-29). Same setup as
// members-service; see ADR-0009.
//
// This file must run BEFORE anything imports `http`, `fastify` or `pino`,
// because OTel instruments libraries by patching them as they load. That's why
// it is not imported by index.ts; Node preloads it instead:
//
//   node --import ./dist/instrumentation.js dist/index.js
//
// The pieces (see docs/study-guide.md §9 "Observability" and §13 "Distributed tracing"):
//   - Instrumentations: HttpInstrumentation records a duration histogram and a
//     SERVER span for every incoming request; fastifyOtel adds the matched
//     route; PinoInstrumentation stamps trace_id/span_id on every log line.
//     Database queries get their spans from src/infrastructure/prisma.ts.
//   - Metrics: PrometheusExporter serves them on http://<pod>:9465/metrics.
//     Prometheus *pulls* (scrapes) from it. Unchanged by tracing.
//   - Traces: *pushed* over OTLP to the OTel Collector, which batches them and
//     forwards them to Tempo. The SDK builds that exporter from env vars the
//     Helm chart sets (charts/events-service, `tracing.otlpEndpoint`):
//       OTEL_TRACES_EXPORTER=otlp
//       OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector.monitoring.svc.cluster.local:4318
//   - Resource: `service.name` identifies which service the data came from.
import { serviceSampler } from "@cms/events";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { PrometheusExporter } from "@opentelemetry/exporter-prometheus";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { PinoInstrumentation } from "@opentelemetry/instrumentation-pino";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { fastifyOtel } from "./infrastructure/fastifyOtel.js";

// Traces are OFF unless the environment turns them on. Without a Collector
// (unit tests, `pnpm dev`) the exporter would log a failed export for every
// batch. Logs never go through OTel here: Alloy reads them from stdout (CMS-28).
process.env.OTEL_TRACES_EXPORTER ??= "none";
process.env.OTEL_LOGS_EXPORTER ??= "none";
// Use the *stable* HTTP semantic conventions: the metric is called
// `http.server.request.duration` (seconds), with `http.route`,
// `http.request.method` and `http.response.status_code` attributes.
process.env.OTEL_SEMCONV_STABILITY_OPT_IN ??= "http";

// 9465, not 9464: members-service uses 9464, and both run on one machine under
// `pnpm dev`. The Helm chart sets METRICS_PORT to the same value.
const METRICS_PORT = Number(process.env.METRICS_PORT ?? 9465);

// SAMPLING decides which traces are kept: every new trace, except database
// spans with no parent (the outbox relay's polling). Shared with the other
// service, and explained in full, in @cms/events (packages/events/src/sampling.ts).

const sdk = new NodeSDK({
  resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: "events-service" }),
  metricReader: new PrometheusExporter({ port: METRICS_PORT }),
  sampler: serviceSampler(),
  instrumentations: [
    new HttpInstrumentation({
      // Count and trace only real API traffic. Two things would otherwise
      // pollute the request-rate graph and the trace list:
      //   - Kubernetes probes, which hit /health every few seconds;
      //   - Prometheus's own scrapes: the exporter's /metrics server is a
      //     Node `http` server too, so it gets instrumented like any other.
      ignoreIncomingRequestHook: (req) =>
        req.url === "/health" || req.socket.localPort === METRICS_PORT,
    }),
    fastifyOtel,
    // Pinned to 0.69.x (package.json): 0.70 moved to the OTel 3.x line, while
    // sdk-node here is 0.223 (2.x). Upgrade them together.
    // Adds trace_id, span_id and trace_flags to every pino line written while a
    // span is active (Fastify's logger is pino). Grafana turns trace_id in a
    // Loki line into a link to the trace. disableLogSending: the lines still go
    // to stdout for Alloy; don't ALSO send them through the OTel logs pipeline.
    new PinoInstrumentation({ disableLogSending: true }),
  ],
});

sdk.start();
// No SIGTERM listener here: index.ts owns shutdown, and calls flushTraces()
// (from @cms/events) after the server has closed, so the spans of the last
// requests are sent before the process exits. A second SIGTERM listener here
// would race index.ts's process.exit().
