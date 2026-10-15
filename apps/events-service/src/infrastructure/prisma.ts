// The generated Prisma client lives in this service's own folder, not in the
// shared node_modules (see the `output` comment in prisma/schema.prisma). This
// file is the one place that knows that path; the rest of the code imports
// Prisma from here.
import { PrismaClient, type Prisma } from "../../generated/client/index.js";

export { Prisma, PrismaClient } from "../../generated/client/index.js";
export type {
  Attendance as AttendanceRow,
  ServiceEvent as ServiceEventRow,
  VolunteerAssignment as VolunteerAssignmentRow,
} from "../../generated/client/index.js";

export const prisma = new PrismaClient();

// Either the full client, or the client of a transaction that's already open
// (see PrismaUnitOfWork). A transaction client can do everything except open
// another transaction.
export type Db = PrismaClient | Prisma.TransactionClient;

// Runs `work` in a transaction. If `db` is already a transaction client, it
// just runs `work` there, so the caller's transaction covers it.
export async function inTransaction<T>(
  db: Db,
  work: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  return "$transaction" in db ? db.$transaction(work) : work(db);
}
