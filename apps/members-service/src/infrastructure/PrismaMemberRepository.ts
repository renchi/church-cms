import type { PrismaClient } from "@prisma/client";
import { Member, type MemberStatus } from "../domain/Member.js";
import type { MemberRepository } from "../domain/MemberRepository.js";
import { prisma as defaultPrisma } from "./prisma.js";

type MemberRow = {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
};

function toMember(row: MemberRow): Member {
  return Member.reconstitute({
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    status: row.status as MemberStatus,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

export class PrismaMemberRepository implements MemberRepository {
  // The Prisma client is injectable so tests can point the repository at a
  // throwaway database (see the integration tests). Production uses the shared
  // singleton by default.
  constructor(private readonly prisma: PrismaClient = defaultPrisma) {}

  async findById(id: string): Promise<Member | null> {
    const row = await this.prisma.member.findUnique({ where: { id } });
    return row ? toMember(row) : null;
  }

  async findByEmail(email: string): Promise<Member | null> {
    const row = await this.prisma.member.findUnique({ where: { email } });
    return row ? toMember(row) : null;
  }

  async list(params: {
    skip: number;
    take: number;
  }): Promise<{ members: Member[]; total: number }> {
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.member.findMany({
        skip: params.skip,
        take: params.take,
        orderBy: { createdAt: "desc" },
      }),
      this.prisma.member.count(),
    ]);
    return { members: rows.map(toMember), total };
  }

  async save(member: Member): Promise<void> {
    const snap = member.toSnapshot();
    await this.prisma.member.upsert({
      where: { id: snap.id },
      create: snap,
      update: {
        name: snap.name,
        phone: snap.phone,
        status: snap.status,
        updatedAt: snap.updatedAt,
      },
    });
  }
}
