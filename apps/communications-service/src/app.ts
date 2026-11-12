import Fastify, { type FastifyInstance } from "fastify";
import { fastifyOtel } from "./infrastructure/fastifyOtel.js";

export interface BuildAppOptions {
  // Quiet by default so tests don't spam the console; index.ts turns it on.
  logger?: boolean;
}

// Same shape as the other two services: build the app without binding a port,
// so tests drive it with `app.inject()` and index.ts calls `app.listen()`.
//
// Communications has no business API yet: its work starts from a NATS message,
// not an HTTP request. The server is here for Kubernetes (the /health probes)
// and for Prometheus (the :9466 metrics server runs beside it, instrumentation.ts).
export function buildApp(opts: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({
    // pino JSON logs; `service` tells the services' lines apart in Loki, and the
    // level is a word ("error", not 50), as in the other services (study-guide §9.9).
    logger: opts.logger
      ? {
          level: process.env.LOG_LEVEL ?? "info",
          base: { service: "communications-service" },
          formatters: { level: (label: string) => ({ level: label }) },
        }
      : false,
  });

  app.register(fastifyOtel.plugin());

  app.get("/", async () => {
    return { service: "communications-service", status: "ok", endpoints: ["/health"] };
  });

  // logLevel "silent": Kubernetes probes call this every few seconds.
  app.get("/health", { logLevel: "silent" }, async () => {
    return { status: "ok" };
  });

  return app;
}
