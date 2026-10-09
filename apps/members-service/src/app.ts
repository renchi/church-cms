import Fastify, { type FastifyInstance } from "fastify";
import { memberRoutes } from "./api/memberRoutes.js";
import type { MemberRepository } from "./domain/MemberRepository.js";
import { fastifyOtel } from "./infrastructure/fastifyOtel.js";

export interface BuildAppOptions {
  // Quiet by default so tests don't spam the console; index.ts turns it on.
  logger?: boolean;
  // Injectable repository for tests; falls back to the Prisma-backed one.
  repo?: MemberRepository;
}

// Builds the Fastify app without binding a port, so tests can drive it via
// `app.inject()` and production can call `app.listen()` (see index.ts).
export function buildApp(opts: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({
    // Fastify's logger is pino: one JSON object per line on stdout, which is
    // what `kubectl logs` shows and what log tools can parse and filter.
    //   level — LOG_LEVEL from the ConfigMap (debug | info | warn | error).
    //   base  — fields added to every line; `service` tells you which service
    //           wrote it once logs from several services are mixed together.
    logger: opts.logger
      ? {
          level: process.env.LOG_LEVEL ?? "info",
          base: { service: "members-service" },
        }
      : false,
  });

  // Labels request metrics with the matched route (see fastifyOtel.ts).
  app.register(fastifyOtel.plugin());

  // Root route — a friendly "it's working" landing page so opening the service
  // URL in a browser confirms it's up, instead of returning a bare 404.
  app.get("/", async () => {
    return {
      service: "members-service",
      status: "ok",
      endpoints: ["/health", "/members"],
    };
  });

  // logLevel "silent": Kubernetes probes call this every few seconds, and
  // logging each one would bury the requests you actually care about.
  app.get("/health", { logLevel: "silent" }, async () => {
    return { status: "ok" };
  });

  app.register(memberRoutes, { repo: opts.repo });

  return app;
}
