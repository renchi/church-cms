import type { TransactionRepositories, UnitOfWork } from "../application/UnitOfWork.js";
import { PrismaWelcomeEmailRepository } from "./PrismaWelcomeEmailRepository.js";
import { prisma as defaultPrisma, type PrismaClient } from "./prisma.js";

export class PrismaUnitOfWork implements UnitOfWork {
  constructor(private readonly prisma: PrismaClient = defaultPrisma) {}

  runOnce<T>(messageId: string, work: (repos: TransactionRepositories) => Promise<T>): Promise<T | null> {
    return this.prisma.$transaction(
      async (tx) => {
        // INSERT ... ON CONFLICT DO NOTHING: records the id, or does nothing if it's
        // already there. Two racing deliveries of one message: the second waits on
        // the first's row lock, then inserts nothing, so only one does the work.
        const { count } = await tx.processedMessage.createMany({
          data: [{ id: messageId }],
          skipDuplicates: true,
        });
        if (count === 0) return null;
        // Bound to THIS transaction: the processed id and the WelcomeEmail row
        // commit together, or not at all.
        return work({ welcomeEmails: new PrismaWelcomeEmailRepository(tx) });
      },
      // The work includes sending the email (SMTP), which can take a few seconds
      // when the mail server is slow. Prisma's default of 5 s would abort the
      // transaction AFTER a successful send, and the redelivery would send again.
      { timeout: 30_000 }
    );
  }
}
