import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { PrismaClient } from "@prisma/client";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { PrismaMemberRepository } from "../infrastructure/PrismaMemberRepository.js";

// Integration tests: real HTTP -> use case -> Prisma -> Postgres against a
// throwaway database (Testcontainers). They need Docker AND a working
// host->container network path, so they are gated behind RUN_DB_TESTS and run
// in CI rather than on every local `pnpm test`.
//
// Why gated: this project's primary dev host has a broken host->container Docker
// data path (TCP handshake succeeds but no client can complete a session), so
// these can't run locally. CI provides a normal Docker environment.
// Follow-up to make them always-on once infra supports it: CMS-25.
const runDbTests = process.env.RUN_DB_TESTS === "1";

// The members-service folder (this file is in src/api/, so go up two levels).
// Needed because ES modules don't have the classic `__dirname` variable.
const serviceDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe.runIf(runDbTests)("Members API (integration)", () => {
  let container: StartedPostgreSqlContainer;
  let prisma: PrismaClient;
  let app: FastifyInstance;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    // Force IPv4: on hosts where `localhost` resolves to ::1, Docker only
    // publishes the mapped port on 0.0.0.0 (IPv4).
    const databaseUrl = container.getConnectionUri().replace("localhost", "127.0.0.1");

    // Apply the committed migrations against the fresh container so the schema
    // matches production exactly. (The client is generated in vitest.globalSetup.ts.)
    execFileSync("npx", ["--no-install", "prisma", "migrate", "deploy"], {
      cwd: serviceDir,
      stdio: "inherit",
      env: { ...process.env, DATABASE_URL: databaseUrl },
    });

    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    app = buildApp({ repo: new PrismaMemberRepository(prisma) });
    await app.ready();
  }, 180_000);

  afterEach(async () => {
    await prisma.member.deleteMany();
  });

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
    await container?.stop();
  });

  describe("POST /members", () => {
    it("creates a member record in the database", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/members",
        payload: { name: "Alice", email: "alice@example.com", phone: "+1234567890" },
      });

      expect(res.statusCode).toBe(201);
      const { id } = res.json<{ id: string }>();
      expect(id).toBeTruthy();

      const row = await prisma.member.findUnique({ where: { id } });
      expect(row).toMatchObject({
        name: "Alice",
        email: "alice@example.com",
        phone: "+1234567890",
        status: "active",
      });
    });

    it("returns 409 when the email is already registered", async () => {
      const first = await app.inject({
        method: "POST",
        url: "/members",
        payload: { name: "Alice", email: "dupe@example.com" },
      });
      expect(first.statusCode).toBe(201);

      const second = await app.inject({
        method: "POST",
        url: "/members",
        payload: { name: "Someone Else", email: "dupe@example.com" },
      });

      expect(second.statusCode).toBe(409);
      expect(await prisma.member.count()).toBe(1);
    });
  });
});
