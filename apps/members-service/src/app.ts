import Fastify, { type FastifyInstance } from "fastify";
import { memberRoutes } from "./api/memberRoutes.js";
import type { MemberRepository } from "./domain/MemberRepository.js";
import { fastifyOtel } from "./infrastructure/fastifyOtel.js";

export interface BuildAppOptions {
  // Quiet by default so tests don't spam the console; index.ts turns it on.
  logger?: boolean;
  // Injectable repository for tests; falls back to the Prisma-backed one.
  repo?: MemberRepository;
  // Where log lines go when `logger` is on. Defaults to stdout; tests pass a
  // stream they can read, to check what a request logs (memberRoutes.test.ts).
  logStream?: { write(line: string): void };
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
    //   formatters.level — write the level as a word ("level":"error") instead
    //           of pino's number ("level":50). Loki queries then read
    //           `| json | level="error"`, and Grafana colours lines by level
    //           (study-guide §9.9).
    logger: opts.logger
      ? {
          level: process.env.LOG_LEVEL ?? "info",
          base: { service: "members-service" },
          formatters: { level: (label: string) => ({ level: label }) },
          ...(opts.logStream ? { stream: opts.logStream } : {}),
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
