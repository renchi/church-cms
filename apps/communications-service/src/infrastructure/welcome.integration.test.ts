// The welcome-email path against a real Postgres (Testcontainers): the Prisma
// repository, the unit of work, and the use case with them, where only the
// recipient resolver and the email sender are fakes.
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { EmailSender } from "../application/EmailSender.js";
import { SendWelcomeEmailUseCase } from "../application/SendWelcomeEmailUseCase.js";
import type { RecipientResolver } from "../domain/RecipientResolver.js";
import { WelcomeEmail } from "../domain/WelcomeEmail.js";
import { PrismaClient } from "./prisma.js";
import { PrismaUnitOfWork } from "./PrismaUnitOfWork.js";
import { PrismaWelcomeEmailRepository } from "./PrismaWelcomeEmailRepository.js";

const serviceDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("welcome email storage (integration)", () => {
  let pg: StartedPostgreSqlContainer;
  let prisma: PrismaClient;

  beforeAll(async () => {
    pg = await new PostgreSqlContainer("postgres:16-alpine").start();
    const databaseUrl = pg.getConnectionUri().replace("localhost", "127.0.0.1");
    execFileSync("npx", ["--no-install", "prisma", "migrate", "deploy"], {
      cwd: serviceDir,
      stdio: "inherit",
      env: { ...process.env, DATABASE_URL: databaseUrl },
    });
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  }, 180_000);

  afterEach(async () => {
    await prisma.welcomeEmail.deleteMany();
    await prisma.processedMessage.deleteMany();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg?.stop();
  });

  function useCase(sender: EmailSender) {
    const resolver: RecipientResolver = {
      resolveMember: async (memberId) => ({ memberId, name: "Ana", email: "ana@example.org", status: "active" }),
    };
    return new SendWelcomeEmailUseCase(
      new PrismaWelcomeEmailRepository(prisma),
      resolver,
      sender,
      new PrismaUnitOfWork(prisma),
      { churchName: "Grace" }
    );
  }

  it("saves and finds a member's welcome email", async () => {
    const repo = new PrismaWelcomeEmailRepository(prisma);
    const at = new Date("2026-11-12T10:00:00.000Z");

    await repo.save(WelcomeEmail.sent("m-1", at));

    expect((await repo.findByMemberId("m-1"))?.toSnapshot()).toEqual({ memberId: "m-1", status: "sent", decidedAt: at });
    expect(await repo.findByMemberId("m-2")).toBeNull();
  });

  it("refuses a second welcome email for the same member: the database enforces 'one per member'", async () => {
    const repo = new PrismaWelcomeEmailRepository(prisma);
    await repo.save(WelcomeEmail.sent("m-1", new Date()));

    await expect(repo.save(WelcomeEmail.skipped("m-1", new Date()))).rejects.toThrow();
    expect((await repo.findByMemberId("m-1"))?.toSnapshot().status).toBe("sent"); // the first decision stands
  });

  it("sends once for a message delivered twice", async () => {
    const sender: EmailSender = { send: vi.fn(async () => {}) };
    const welcome = useCase(sender);

    expect(await welcome.execute({ messageId: "msg-1", memberId: "m-1" })).toBe("sent");
    expect(await welcome.execute({ messageId: "msg-1", memberId: "m-1" })).toBe("duplicate");

    expect(sender.send).toHaveBeenCalledTimes(1);
    expect(await prisma.processedMessage.count()).toBe(1);
  });

  // The message-id guard on its own. Through the use case it's hard to reach: the
  // per-member check answers "duplicate" first once a WelcomeEmail exists. It matters
  // when that row isn't there yet: a redelivery that arrives while the first delivery's
  // transaction is still open (ack_wait ran out mid-send).
  it("runOnce does the work once per message id, and returns null for a seen id", async () => {
    const uow = new PrismaUnitOfWork(prisma);
    const work = vi.fn(async () => "done");

    expect(await uow.runOnce("msg-1", work)).toBe("done");
    expect(await uow.runOnce("msg-1", work)).toBeNull();

    expect(work).toHaveBeenCalledTimes(1);
  });

  it("runOnce lets one of two racing deliveries of a message do the work", async () => {
    const uow = new PrismaUnitOfWork(prisma);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const work = vi.fn(async () => {
      await held; // the first delivery is still mid-send…
      return "done";
    });

    const first = uow.runOnce("msg-race", work);
    await new Promise((resolve) => setTimeout(resolve, 200)); // …when the second arrives
    const second = uow.runOnce("msg-race", work);
    release();

    expect(await Promise.all([first, second])).toEqual(["done", null]);
    expect(work).toHaveBeenCalledTimes(1);
  });

  it("records nothing, message id included, when the send fails, so the redelivery sends it", async () => {
    let failing = true;
    const sender: EmailSender = {
      send: vi.fn(async () => {
        if (failing) throw new Error("SMTP connection refused");
      }),
    };
    const welcome = useCase(sender);

    await expect(welcome.execute({ messageId: "msg-1", memberId: "m-1" })).rejects.toThrow("SMTP");
    expect(await prisma.welcomeEmail.count()).toBe(0);
    expect(await prisma.processedMessage.count()).toBe(0); // rolled back with it

    failing = false;
    expect(await welcome.execute({ messageId: "msg-1", memberId: "m-1" })).toBe("sent");
    expect(sender.send).toHaveBeenCalledTimes(2);
  });
});
