// The generated Prisma client lives in this service's own folder, not in the
// shared node_modules (see the `output` comment in prisma/schema.prisma). This
// file is the one place that knows that path; the rest of the code imports
// Prisma from here.
import { PrismaClient } from "../../generated/client/index.js";

export { Prisma, PrismaClient } from "../../generated/client/index.js";
export type {
  Attendance as AttendanceRow,
  ServiceEvent as ServiceEventRow,
  VolunteerAssignment as VolunteerAssignmentRow,
} from "../../generated/client/index.js";

export const prisma = new PrismaClient();
