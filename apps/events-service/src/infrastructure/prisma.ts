// The generated Prisma client lives in this service's own folder, not in the
// shared node_modules (see the `output` comment in prisma/schema.prisma). This
// file is the one place that knows that path; the rest of the code imports
// Prisma from here.
import { inDbSpan } from "@cms/events";
import { PrismaClient, type Prisma } from "../../generated/client/index.js";

export { Prisma, PrismaClient } from "../../generated/client/index.js";
export type {
  Attendance as AttendanceRow,
  ServiceEvent as ServiceEventRow,
  VolunteerAssignment as VolunteerAssignmentRow,
} from "../../generated/client/index.js";

export const prisma = new PrismaClient();

// One span per database query (CMS-29), e.g. "prisma:Attendance.create". The
// span itself is built by inDbSpan in @cms/events, shared with members-service.
//
// Why not the official @prisma/instrumentation? Its Prisma 5 release builds
// spans with the 1.x OTel SDK, and crashed against the 2.x SDK we run
// (`parentTracer.getSpanLimits is not a function`, study-guide §13.4).
// Middleware ($use) is deprecated in favour of client extensions, but an
// extension changes the client's type everywhere it is used. When Prisma is
// upgraded (6+), switch back to @prisma/instrumentation, which then also shows
// the engine's own spans (connection, SQL).
prisma.$use((params, next) => inDbSpan(params.model, params.action, () => next(params)));

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
