import { afterEach, describe, expect, it, vi } from "vitest";
import { trace } from "@opentelemetry/api";
import { logEvent } from "./log";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function captureLines() {
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  return () => spy.mock.calls.map((call) => JSON.parse(call[0] as string));
}

describe("logEvent", () => {
  it("writes one JSON line in the same shape as the services' pino lines", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    logEvent("info", { memberId: "m-1", status: 201 }, "registration succeeded");

    expect(spy).toHaveBeenCalledOnce();
    const raw = spy.mock.calls[0]?.[0] as string;
    // One line: Loki treats each newline as a new log entry.
    expect(raw).not.toContain("\n");
    expect(JSON.parse(raw)).toEqual({
      level: "info",
      time: expect.any(Number),
      service: "web",
      memberId: "m-1",
      status: 201,
      msg: "registration succeeded",
    });
  });

  it("never lets a field overwrite level, time, service or msg", () => {
    const lines = captureLines();

    logEvent(
      "error",
      { level: "info", time: 0, service: "members-service", msg: "overwritten?" },
      "registration failed"
    );

    expect(lines()[0]).toMatchObject({
      level: "error",
      service: "web",
      msg: "registration failed",
    });
    expect(lines()[0].time).not.toBe(0);
  });

  it("writes an Error as its type and message, not {}", () => {
    const lines = captureLines();

    logEvent("error", { err: new TypeError("fetch failed") }, "could not load members");

    expect(lines()[0].err).toEqual({ type: "TypeError", message: "fetch failed" });
  });

  it("drops lines below LOG_LEVEL", () => {
    vi.stubEnv("LOG_LEVEL", "warn");
    const lines = captureLines();

    logEvent("info", {}, "registration succeeded");
    logEvent("warn", {}, "registration failed");

    expect(lines().map((l) => l.msg)).toEqual(["registration failed"]);
  });

  it("logs info and above when LOG_LEVEL is unset", () => {
    vi.stubEnv("LOG_LEVEL", "");
    const lines = captureLines();

    logEvent("debug", {}, "noisy");
    logEvent("info", {}, "registration succeeded");

    expect(lines().map((l) => l.msg)).toEqual(["registration succeeded"]);
  });

  it("adds trace_id and span_id while a span is active, so Grafana can link the line to its trace", () => {
    const read = captureLines();
    const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    const spanId = "00f067aa0ba902b7";
    // In production Next.js's request span is the active one. Here there is no
    // SDK, so stand in a span with known ids.
    vi.spyOn(trace, "getActiveSpan").mockReturnValue(trace.wrapSpanContext({ traceId, spanId, traceFlags: 1 }));

    logEvent("info", {}, "registration succeeded");

    expect(read()[0]).toMatchObject({ trace_id: traceId, span_id: spanId });
  });

  it("leaves the trace keys out when nothing is being traced", () => {
    const read = captureLines();
    logEvent("info", {}, "registration succeeded");
    expect(read()[0]).not.toHaveProperty("trace_id");
  });
});

