// OpenTelemetry bootstrap — metrics only. Same setup as members-service (CMS-24, ADR-0009).
//
// This file must run BEFORE anything imports `http` or `fastify`, because
// OTel instruments libraries by patching them as they load. That's why it is
// not imported by index.ts; Node preloads it instead:
//
//   node --import ./dist/instrumentation.js dist/index.js
//
// The pieces (see docs/study-guide.md §9 "Observability"):
//   - Instrumentations: HttpInstrumentation records a duration histogram for
//     every incoming request; fastifyOtel adds the matched route to it.
//   - Exporter: PrometheusExporter serves the collected metrics as text on
//     http://<pod>:9464/metrics. Prometheus *pulls* (scrapes) from it.
//   - Resource: `service.name` identifies which service the metrics came from.
//
// Deliberately NOT here yet: traces and an OTel Collector. ADR-0009 adds them
// once NATS is live (CMS-22), when work actually crosses service boundaries.
import { NodeSDK } from "@opentelemetry/sdk-node";
import { PrometheusExporter } from "@opentelemetry/exporter-prometheus";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { fastifyOtel } from "./infrastructure/fastifyOtel.js";

// NodeSDK defaults to exporting traces and logs over OTLP to localhost:4318.
// We have no Collector, so switch those off — otherwise every request would
// log a failed export. Env vars still win, for experimenting.
process.env.OTEL_TRACES_EXPORTER ??= "none";
process.env.OTEL_LOGS_EXPORTER ??= "none";
// Use the *stable* HTTP semantic conventions: the metric is called
// `http.server.request.duration` (seconds), with `http.route`,
// `http.request.method` and `http.response.status_code` attributes.
process.env.OTEL_SEMCONV_STABILITY_OPT_IN ??= "http";

// 9465, not 9464: members-service uses 9464, and both run on one machine under
// `pnpm dev`. The Helm chart sets METRICS_PORT to the same value.
const METRICS_PORT = Number(process.env.METRICS_PORT ?? 9465);

const sdk = new NodeSDK({
  resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: "events-service" }),
  metricReader: new PrometheusExporter({ port: METRICS_PORT }),
  instrumentations: [
    new HttpInstrumentation({
      // Count only real API traffic. Two things would otherwise pollute the
      // request-rate graph:
      //   - Kubernetes probes, which hit /health every few seconds;
      //   - Prometheus's own scrapes: the exporter's /metrics server is a
      //     Node `http` server too, so it gets instrumented like any other.
      ignoreIncomingRequestHook: (req) =>
        req.url === "/health" || req.socket.localPort === METRICS_PORT,
    }),
    fastifyOtel,
  ],
});

// No shutdown hook on purpose: with a pull exporter there is nothing buffered
// to flush, and adding a SIGTERM listener would stop Node's default
// exit-on-SIGTERM (Pods would hang until Kubernetes force-kills them).
sdk.start();
