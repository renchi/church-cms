import Fastify from "fastify";
import { memberRoutes } from "./api/memberRoutes.js";
import { prisma } from "./infrastructure/prisma.js";

const app = Fastify({ logger: true });

// Root route — a friendly "it's working" landing page so opening the service URL
// in a browser confirms it's up, instead of returning a bare 404.
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

app.register(memberRoutes);

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
