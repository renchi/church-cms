import { buildApp } from "./app.js";
import { prisma } from "./infrastructure/prisma.js";

const app = buildApp({ logger: true });

app.addHook("onClose", async () => {
  await prisma.$disconnect();
});

const start = async () => {
  try {
    await prisma.$connect();
    await app.listen({ port: 3001, host: "0.0.0.0" });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();
