import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { MemberRepository } from "./domain/MemberRepository.js";

// Exercises the real OTel SDK end to end: start it the way production does
// (before Fastify loads), send real HTTP requests, then scrape /metrics like
// Prometheus would. A separate port keeps it clear of a locally running dev
// server on 9464.
const METRICS_PORT = 9465;

const repo: MemberRepository = {
  findById: async () => null,
  findByEmail: async () => null,
  list: async () => ({ members: [], total: 0 }),
  save: async () => undefined,
};

describe("OpenTelemetry metrics", () => {
  let app: FastifyInstance;
  let baseUrl: string;

  beforeAll(async () => {
    process.env.METRICS_PORT = String(METRICS_PORT);
    // Order matters: instrumentation first, app second — same as
    // `node --import ./dist/instrumentation.js dist/index.js`.
    await import("./instrumentation.js");
    const { buildApp } = await import("./app.js");
    app = buildApp({ repo });
    baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });
  });

  afterAll(async () => {
    await app?.close();
  });

  async function scrape(): Promise<string> {
    const res = await fetch(`http://127.0.0.1:${METRICS_PORT}/metrics`);
    expect(res.status).toBe(200);
    return res.text();
  }

  it("records request durations labelled with the route template, not the raw URL", async () => {
    await fetch(`${baseUrl}/members/abc`);
    await fetch(`${baseUrl}/members/xyz`);

    const metrics = await scrape();

    expect(metrics).toContain("# TYPE http_server_request_duration histogram");
    // Two different ids → one series, so label cardinality stays bounded.
    expect(metrics).toMatch(
      /http_server_request_duration_count\{[^}]*http_route="\/members\/:id"[^}]*http_response_status_code="404"[^}]*\} 2/
    );
    expect(metrics).not.toContain("/members/abc");
  });

  it("does not count Kubernetes health probes", async () => {
    await fetch(`${baseUrl}/health`);

    const metrics = await scrape();

    expect(metrics).not.toContain('http_route="/health"');
  });

  it("does not count Prometheus's own scrapes of /metrics", async () => {
    await scrape();
    await scrape();

    const metrics = await scrape();

    // A scrape would show up as a 200 with no route (it isn't a Fastify route).
    const unroutedOk = metrics
      .split("\n")
      .filter((line) => line.startsWith("http_server_request_duration_count{"))
      .filter((line) => !line.includes("http_route=") && line.includes('status_code="200"'));
    expect(unroutedOk).toEqual([]);
  });
});
