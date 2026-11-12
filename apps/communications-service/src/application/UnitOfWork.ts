import type { WelcomeEmailRepository } from "../domain/WelcomeEmailRepository.js";

// Handling a message from another context exactly once (ADR-0010), like the
// other two services' UnitOfWork. JetStream delivers AT LEAST once, so the same
// MemberRegistered can arrive twice.
//
// runOnce(messageId, work) runs `work` in ONE database transaction that also
// records `messageId` as processed, and returns what `work` returned. If the id
// was already recorded it skips `work` and returns null. If `work` throws, the
// transaction rolls back, the id included, so a redelivery tries again.
// Implementation: infrastructure/PrismaUnitOfWork.ts.
export interface TransactionRepositories {
  welcomeEmails: WelcomeEmailRepository;
}

export interface UnitOfWork {
  runOnce<T>(messageId: string, work: (repos: TransactionRepositories) => Promise<T>): Promise<T | null>;
}
