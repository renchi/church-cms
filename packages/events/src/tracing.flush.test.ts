// flushTraces runs during shutdown, so it must never hang or throw: a Pod has
// ~25 s between SIGTERM and SIGKILL, and a rejection would turn a clean stop
// into exit code 1 (index.ts).
//
// Tests flushTraces from tracing.ts. A file of its own, not part of
// tracing.test.ts: each test here installs a fake global tracer provider and
// tears it down, while tracing.test.ts keeps one real provider for the whole file.
import { afterEach, describe, expect, it } from "vitest";
import { trace, type TracerProvider } from "@opentelemetry/api";
import { flushTraces } from "./tracing.js";

function installProvider(forceFlush: () => Promise<void>): void {
  const provider = {
    getTracer: () => trace.getTracer("noop"),
    forceFlush,
  } as unknown as TracerProvider;
  trace.setGlobalTracerProvider(provider);
}
afterEach(() => trace.disable());

describe("flushTraces", () => {
  it("resolves true once the SDK has flushed", async () => {
    installProvider(async () => {});
    expect(await flushTraces()).toBe(true);
  });

  it("gives up after the timeout when an export hangs (the Collector is down)", async () => {
    installProvider(() => new Promise(() => {})); // never settles
    const started = Date.now();
    expect(await flushTraces(50)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("resolves false instead of rejecting when the export fails", async () => {
    installProvider(() => Promise.reject(new Error("ECONNREFUSED")));
    expect(await flushTraces()).toBe(false);
  });

  it("is a no-op without an SDK (tracing off)", async () => {
    expect(await flushTraces()).toBe(true);
  });
});
