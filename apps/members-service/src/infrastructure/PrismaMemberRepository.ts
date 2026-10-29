import { captureTraceContext } from "@cms/events";
import { Member, type MemberStatus } from "../domain/Member.js";
import { ConflictError } from "../domain/errors.js";
import type { MemberDomainEvent } from "../domain/events.js";
import type { MemberRepository } from "../domain/MemberRepository.js";
import { toOutboxMessage } from "./outbox.js";
import { prisma as defaultPrisma, inTransaction, type Db, type Prisma } from "./prisma.js";
import { rethrowUniqueViolation } from "./uniqueViolation.js";

type MemberRow = {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  status: string;
  attendanceCount: number;
  lastAttendedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
};

function toMember(row: MemberRow): Member {
  return Member.reconstitute({
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    status: row.status as MemberStatus,
    attendanceCount: row.attendanceCount,
    lastAttendedAt: row.lastAttendedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    version: row.version,
  });
}

export class PrismaMemberRepository implements MemberRepository {
  // The Prisma client is injectable so tests can point the repository at a
  // throwaway database (see the integration tests), and so PrismaUnitOfWork can
  // pass a transaction's client. Production uses the shared singleton by default.
  constructor(private readonly db: Db = defaultPrisma) {}

  async findById(id: string): Promise<Member | null> {
    const row = await this.db.member.findUnique({ where: { id } });
    return row ? toMember(row) : null;
  }

  async findByEmail(email: string): Promise<Member | null> {
    const row = await this.db.member.findUnique({ where: { email } });
    return row ? toMember(row) : null;
  }

  async list(params: {
    skip: number;
    take: number;
  }): Promise<{ members: Member[]; total: number }> {
    const page = this.db.member.findMany({
      skip: params.skip,
      take: params.take,
      orderBy: { createdAt: "desc" },
    });
    const count = this.db.member.count();
    // A batch transaction sends both queries in one round trip. Inside an open
    // transaction (a transaction client has no $transaction), just run both there.
    const [rows, total] =
      "$transaction" in this.db ? await this.db.$transaction([page, count]) : await Promise.all([page, count]);
    return { members: rows.map(toMember), total };
  }

  // The transactional outbox (ADR-0010): the member row and the outbox rows
  // for its events are written in ONE transaction. If anything fails, neither
  // is saved, so another context can never hear about a change that didn't
  // happen, nor miss one that did.
  //
  // Optimistic locking: an existing member is only updated if its stored
  // version still equals the version we loaded. Otherwise someone else saved it
  // in between (an HTTP request, or the attendance consumer in another Pod), and
  // writing our whole snapshot would undo their change. We throw ConflictError
  // instead: the API answers 409, and the consumer naks and retries on fresh data.
  async save(member: Member, events: MemberDomainEvent[] = []): Promise<void> {
    const snap = member.toSnapshot();
    // Only events in the published contract become outbox rows (toOutboxMessage
    // returns null for the others, like MemberUpdated).
    const messages = events.map(toOutboxMessage).filter((m) => m !== null);

    await inTransaction(this.db, async (tx) => {
      if (snap.version === 0) {
        // The email is unique in the database. A concurrent registration with
        // the same email loses here, and the whole transaction (its outbox row
        // included) rolls back.
        await rethrowUniqueViolation(tx.member.create({ data: { ...snap, version: 1 } }), "Email already registered");
      } else {
        const { count } = await tx.member.updateMany({
          where: { id: snap.id, version: snap.version },
          // Everything except id, email and createdAt, which never change.
          data: {
            name: snap.name,
            phone: snap.phone,
            status: snap.status,
            attendanceCount: snap.attendanceCount,
            lastAttendedAt: snap.lastAttendedAt,
            updatedAt: snap.updatedAt,
            version: { increment: 1 },
          },
        });
        // Throwing here rolls back the whole transaction, outbox rows included.
        if (count === 0) {
          throw new ConflictError("The member was changed by another request; reload it and try again");
        }
      }
      if (messages.length > 0) {
        // The trace context of the request saving this aggregate, so the relay
        // can continue the trace later (CMS-29, @cms/events tracing.ts). One
        // value for every row: they're all written by the same request.
        const traceparent = captureTraceContext();
        await tx.outboxMessage.createMany({
          data: messages.map((m) => ({
            id: m.id,
            subject: m.subject,
            payload: m.payload as unknown as Prisma.InputJsonValue,
            traceparent,
          })),
        });
      }
    });
  }
}
