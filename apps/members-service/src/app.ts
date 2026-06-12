import Fastify, { type FastifyInstance } from "fastify";
import { memberRoutes } from "./api/memberRoutes.js";
import type { MemberRepository } from "./domain/MemberRepository.js";

export interface BuildAppOptions {
  // Quiet by default so tests don't spam the console; index.ts turns it on.
  logger?: boolean;
  // Injectable repository for tests; falls back to the Prisma-backed one.
  repo?: MemberRepository;
}

// Builds the Fastify app without binding a port, so tests can drive it via
// `app.inject()` and production can call `app.listen()` (see index.ts).
export function buildApp(opts: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false });

  // Root route — a friendly "it's working" landing page so opening the service
  // URL in a browser confirms it's up, instead of returning a bare 404.
  app.get("/", async () => {
    return {
      service: "members-service",
      status: "ok",
      endpoints: ["/health", "/members"],
    };
  });

  app.get("/health", async () => {
    return { status: "ok" };
  });

  app.register(memberRoutes, { repo: opts.repo });

  return app;
}
