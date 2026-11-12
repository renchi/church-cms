import type { WelcomeEmail } from "./WelcomeEmail.js";

// Storage for WelcomeEmail decisions. The Prisma implementation is
// infrastructure/PrismaWelcomeEmailRepository.ts.
export interface WelcomeEmailRepository {
  findByMemberId(memberId: string): Promise<WelcomeEmail | null>;
  // Inserts. A second WelcomeEmail for the same member fails (memberId is the
  // primary key): "at most one welcome email per member" holds in storage.
  save(email: WelcomeEmail): Promise<void>;
}
