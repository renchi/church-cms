import type { UnitOfWork } from "../application/UnitOfWork.js";
import type { MemberRepository } from "../domain/MemberRepository.js";
import { PrismaMemberRepository } from "./PrismaMemberRepository.js";
import { prisma as defaultPrisma, type PrismaClient } from "./prisma.js";

export class PrismaUnitOfWork implements UnitOfWork {
  constructor(private readonly prisma: PrismaClient = defaultPrisma) {}

  runOnce(messageId: string, work: (members: MemberRepository) => Promise<void>): Promise<boolean> {
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
      // A repository bound to THIS transaction: its save() joins it instead of
      // opening its own, so the processed id and the change commit together.
      await work(new PrismaMemberRepository(tx));
      return true;
    });
  }
}
