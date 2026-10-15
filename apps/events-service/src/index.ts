import { buildApp } from "./app.js";
import { startMessaging, type Messaging } from "./infrastructure/messaging.js";
import { prisma } from "./infrastructure/prisma.js";

// 3002: members-service has 3001. Every service gets its own port so they can
// all run side by side with `pnpm dev` (in Kubernetes each Pod has its own IP,
// so there it wouldn't matter).
const PORT = Number(process.env.PORT ?? 3002);

const app = buildApp({ logger: true });
let messaging: Messaging | undefined;

// Fastify runs onClose hooks when app.close() is called (see shutdown below).
// Stop messaging first so no message is half-handled when the DB disconnects.
// A failure there (e.g. NATS unreachable, so drain() fails) is logged, and the
// database is disconnected anyway.
app.addHook("onClose", async () => {
  await messaging?.stop().catch((err: unknown) => app.log.error({ err }, "stopping messaging failed"));
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

  // Messaging starts AFTER the server is up, and isn't awaited by it: HTTP
  // keeps working while NATS is down (ADR-0010). Without NATS_URL (e.g.
  // `pnpm dev` with no NATS), outbox rows simply wait to be published.
  const natsUrl = process.env.NATS_URL;
  if (!natsUrl) {
    app.log.warn("NATS_URL not set: messaging disabled, outbox events will not be published");
    return;
  }
  startMessaging({
    natsUrl,
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
  app.close().then(
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
