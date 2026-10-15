import type { VolunteerAssignmentRepository } from "../domain/VolunteerAssignmentRepository.js";

// A port for handling a message from another context exactly once
// (ADR-0010). JetStream delivers AT LEAST once, so the same MemberArchived
// message can arrive twice.
//
// runOnce(messageId, work) runs `work` in ONE database transaction that also
// records `messageId` as processed. If the id was already recorded, it skips
// `work` and returns false. The repositories `work` receives are bound to that
// transaction. Implementation: src/infrastructure/PrismaUnitOfWork.ts.
export interface TransactionRepositories {
  volunteerAssignments: VolunteerAssignmentRepository;
}

export interface UnitOfWork {
  runOnce(messageId: string, work: (repos: TransactionRepositories) => Promise<void>): Promise<boolean>;
}
