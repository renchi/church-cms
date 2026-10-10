import Fastify, { type FastifyInstance } from "fastify";
import { eventRoutes, type EventRoutesOptions } from "./api/eventRoutes.js";
import { fastifyOtel } from "./infrastructure/fastifyOtel.js";

export interface BuildAppOptions extends EventRoutesOptions {
  // Quiet by default so tests don't spam the console; index.ts turns it on.
  logger?: boolean;
}

// Same shape as members-service: build the app without binding a port, so
// tests drive it with `app.inject()` and index.ts calls `app.listen()`.
export function buildApp(opts: BuildAppOptions = {}): FastifyInstance {
  const { logger, ...repos } = opts;
  const app = Fastify({
    // pino JSON logs; `service` tells the two services' lines apart once
    // `kubectl logs` output from both is mixed together (study-guide §9.6).
    logger: logger
      ? {
          level: process.env.LOG_LEVEL ?? "info",
          base: { service: "events-service" },
        }
      : false,
  });

  // Labels request metrics with the matched route (see fastifyOtel.ts).
  app.register(fastifyOtel.plugin());

  app.get("/", async () => {
    return {
      service: "events-service",
      status: "ok",
      endpoints: ["/health", "/events"],
    };
  });

  // logLevel "silent": Kubernetes probes call this every few seconds.
  app.get("/health", { logLevel: "silent" }, async () => {
    return { status: "ok" };
  });

  app.register(eventRoutes, repos);

  return app;
}
