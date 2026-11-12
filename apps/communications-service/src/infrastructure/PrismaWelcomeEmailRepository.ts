import { WelcomeEmail, type WelcomeEmailStatus } from "../domain/WelcomeEmail.js";
import type { WelcomeEmailRepository } from "../domain/WelcomeEmailRepository.js";
import { prisma as defaultPrisma, type Db, type WelcomeEmailRow } from "./prisma.js";

// The WelcomeEmail table, as the domain's repository. `db` is the full client, or
// a transaction's client when PrismaUnitOfWork hands one in.
export class PrismaWelcomeEmailRepository implements WelcomeEmailRepository {
  constructor(private readonly db: Db = defaultPrisma) {}

  async findByMemberId(memberId: string): Promise<WelcomeEmail | null> {
    const row = await this.db.welcomeEmail.findUnique({ where: { memberId } });
    return row ? toDomain(row) : null;
  }

  // A plain INSERT, not an upsert: a second WelcomeEmail for the same member must
  // FAIL (primary key), never overwrite the first decision.
  async save(email: WelcomeEmail): Promise<void> {
    await this.db.welcomeEmail.create({ data: email.toSnapshot() });
  }
}

function toDomain(row: WelcomeEmailRow): WelcomeEmail {
  return WelcomeEmail.reconstitute({
    memberId: row.memberId,
    status: row.status as WelcomeEmailStatus,
    decidedAt: row.decidedAt,
  });
}
