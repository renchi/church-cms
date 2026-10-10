import { buildApp } from "./app.js";
import { prisma } from "./infrastructure/prisma.js";

// 3002: members-service has 3001. Every service gets its own port so they can
// all run side by side with `pnpm dev` (in Kubernetes each Pod has its own IP,
// so there it wouldn't matter).
const PORT = Number(process.env.PORT ?? 3002);

const app = buildApp({ logger: true });

app.addHook("onClose", async () => {
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
};

start();
