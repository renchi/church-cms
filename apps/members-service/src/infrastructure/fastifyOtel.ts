import { FastifyOtelInstrumentation } from "@fastify/otel";

// One shared instance, used in two places:
//   - src/instrumentation.ts hands it to the OpenTelemetry SDK (so it gets the
//     SDK's providers), and
//   - src/app.ts registers its Fastify plugin on the app.
//
// Why register the plugin by hand instead of letting the SDK patch Fastify
// automatically? This service is ESM (`"type": "module"`), and OTel's automatic
// patching hooks `require()` — an ESM `import "fastify"` can slip past it. An
// explicit `app.register(...)` always works and is easier to see.
//
// What the plugin does for metrics: it tells the HTTP instrumentation which
// Fastify *route template* matched (`/members/:id`), so request metrics get a
// bounded `http_route` label instead of one label per raw URL.
//
// Outside the SDK (e.g. unit tests via app.inject()) the plugin is a harmless
// no-op: there is no provider to record to.
export const fastifyOtel = new FastifyOtelInstrumentation();
