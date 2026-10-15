import type { TransactionRepositories, UnitOfWork } from "../application/UnitOfWork.js";
import { PrismaVolunteerAssignmentRepository } from "./PrismaVolunteerAssignmentRepository.js";
import { prisma as defaultPrisma, type PrismaClient } from "./prisma.js";

export class PrismaUnitOfWork implements UnitOfWork {
  constructor(private readonly prisma: PrismaClient = defaultPrisma) {}

  runOnce(messageId: string, work: (repos: TransactionRepositories) => Promise<void>): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      // INSERT ... ON CONFLICT DO NOTHING: inserts the id, or does nothing if
      // it's already there. If two deliveries of the same message race, the
      // second waits on the first's row lock, then inserts nothing. So exactly
      // one of them gets count 1 and does the work.
      const { count } = await tx.processedMessage.createMany({
        data: [{ id: messageId }],
        skipDuplicates: true,
      });
      if (count === 0) return false;
      // Repositories bound to THIS transaction, so the processed id and the
      // declined assignments commit together, or not at all.
      await work({ volunteerAssignments: new PrismaVolunteerAssignmentRepository(tx) });
      return true;
    });
  }
}
