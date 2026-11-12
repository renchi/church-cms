import { flushTraces } from "@cms/events";
import { buildApp } from "./app.js";
import { startMessaging, type Messaging } from "./infrastructure/messaging.js";
import { prisma } from "./infrastructure/prisma.js";

// 3003: members-service has 3001, events-service 3002. Every service gets its own
// port so they can all run side by side with `pnpm dev` (in Kubernetes each Pod
// has its own IP, so there it wouldn't matter).
const PORT = Number(process.env.PORT ?? 3003);

// Read once at startup, and required: a welcome email with no sender, or a lookup
// with no Members URL, can't work, and failing at boot (CrashLoopBackOff, with
// this message in the log) beats failing on every message. The Helm chart and
// docker-compose.yml set all of them (scripts/check-env.sh checks the chart).
// Each caller reads its own variable by its literal name, and passes the value
// in. scripts/check-env.sh finds what an app reads by those literal names, so a
// lookup by a computed name in here would hide all five from it.
function required(name: string, value: string | undefined): string {
  if (!value) {
    console.error(JSON.stringify({ level: "fatal", service: "communications-service", msg: `${name} is not set` }));
    process.exit(1);
  }
  return value;
}

const app = buildApp({ logger: true });
let messaging: Messaging | undefined;

// Fastify runs onClose hooks when app.close() is called (see shutdown below).
// Stop messaging first so no message is half-handled when the DB disconnects.
// A failure there (e.g. NATS unreachable, so drain() fails) is logged, and the
// database is disconnected anyway.
app.addHook("onClose", async () => {
  await messaging
    ?.stop()
    .catch((err: unknown) => app.log.error({ err }, "stopping messaging failed"));
  await prisma.$disconnect();
});

const start = async () => {
  try {
    await prisma.$connect();
    await app.listen({ port: PORT, host: "0.0.0.0" });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  // Messaging starts AFTER the server is up, and isn't awaited by it: the health
  // endpoint keeps answering while NATS is down (ADR-0010). Without NATS_URL
  // (`pnpm dev` with no NATS) there's nothing to react to.
  const natsUrl = process.env.NATS_URL;
  if (!natsUrl) {
    app.log.warn("NATS_URL not set: messaging disabled, no welcome emails will be sent");
    return;
  }
  startMessaging({
    config: {
      natsUrl,
      membersApiUrl: required("MEMBERS_API_URL", process.env.MEMBERS_API_URL),
      smtp: {
        host: required("SMTP_HOST", process.env.SMTP_HOST),
        port: Number(required("SMTP_PORT", process.env.SMTP_PORT)),
        from: required("WELCOME_FROM", process.env.WELCOME_FROM),
      },
      churchName: required("CHURCH_NAME", process.env.CHURCH_NAME),
    },
    prisma,
    log: app.log,
    // The consumer stopped on its own (e.g. its durable consumer was deleted).
    // Exit so Kubernetes restarts the Pod; on startup, ensureConsumer recreates it.
    onFailure: (err) => {
      app.log.error({ err }, "message consumer failed; exiting so the Pod restarts");
      process.exit(1);
    },
  })
    .then((m) => {
      messaging = m;
    })
    .catch((err) => {
      // e.g. a stream config NATS rejects. Without messaging the service is
      // only half working, so exit and let Kubernetes restart it.
      app.log.error({ err }, "messaging failed to start");
      process.exit(1);
    });
};

// Kubernetes sends SIGTERM before stopping a Pod; Ctrl+C in `pnpm dev` sends
// SIGINT. Closing gracefully lets the consumer finish its current message and
// drain the NATS connection. A second signal while closing is ignored.
let shuttingDown = false;
function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "shutting down");
  // Close the server first (finishes in-flight requests and messages), then
  // send the spans still buffered in memory, then exit (CMS-29). The flush is
  // capped at 3 s and never fails the shutdown: losing the last spans is better
  // than being SIGKILLed, or exiting 1 after a clean stop.
  app
    .close()
    .then(async () => {
      if (!(await flushTraces()))
        app.log.warn("could not send the last trace spans before exiting");
    })
    .then(
      () => process.exit(0),
      (err: unknown) => {
        app.log.error({ err }, "shutdown failed");
        process.exit(1);
      }
    );
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

start();
