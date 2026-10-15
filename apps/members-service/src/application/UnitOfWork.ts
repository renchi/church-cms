import type { MemberRepository } from "../domain/MemberRepository.js";

// A port for handling a message from another context exactly once
// (ADR-0010). JetStream delivers AT LEAST once, so the same message can
// arrive twice; doing its work twice would, for example, count one
// attendance as two.
//
// runOnce(messageId, work) runs `work` in ONE database transaction that also
// records `messageId` as processed. If the id was already recorded, it skips
// `work` and returns false. Because the record and the change commit together,
// there's no moment where one is saved without the other.
//
// The repository `work` receives is bound to that transaction. The Prisma
// implementation is src/infrastructure/PrismaUnitOfWork.ts.
export interface UnitOfWork {
  runOnce(messageId: string, work: (members: MemberRepository) => Promise<void>): Promise<boolean>;
}
