import type { FastifyInstance, FastifyReply } from "fastify";
import { AssignVolunteerUseCase } from "../application/AssignVolunteerUseCase.js";
import { CancelEventUseCase } from "../application/CancelEventUseCase.js";
import { RecordAttendanceUseCase } from "../application/RecordAttendanceUseCase.js";
import { ScheduleEventUseCase } from "../application/ScheduleEventUseCase.js";
import { UpdateEventUseCase } from "../application/UpdateEventUseCase.js";
import { AVAILABLE_CHECK_IN_METHODS, type CheckInMethod } from "../domain/Attendance.js";
import type { AttendanceRepository } from "../domain/AttendanceRepository.js";
import { ConflictError, DomainError, NotFoundError } from "../domain/errors.js";
import { EVENT_TYPES, type EventType } from "../domain/ServiceEvent.js";
import type { ServiceEventRepository } from "../domain/ServiceEventRepository.js";
import { VOLUNTEER_ROLES, type VolunteerRole } from "../domain/VolunteerAssignment.js";
import type { VolunteerAssignmentRepository } from "../domain/VolunteerAssignmentRepository.js";
import { PrismaAttendanceRepository } from "../infrastructure/PrismaAttendanceRepository.js";
import { PrismaServiceEventRepository } from "../infrastructure/PrismaServiceEventRepository.js";
import { PrismaVolunteerAssignmentRepository } from "../infrastructure/PrismaVolunteerAssignmentRepository.js";

export interface EventRoutesOptions {
  // Injectable so tests can supply in-memory or throwaway-database
  // repositories. Each defaults to its Prisma-backed implementation.
  events?: ServiceEventRepository;
  attendances?: AttendanceRepository;
  volunteers?: VolunteerAssignmentRepository;
}

function handleError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof NotFoundError) return reply.status(404).send({ error: err.message });
  if (err instanceof ConflictError) return reply.status(409).send({ error: err.message });
  if (err instanceof DomainError) return reply.status(400).send({ error: err.message });
  throw err;
}

// JSON-schema fragments. Fastify validates every request against these BEFORE
// the handler runs, so malformed input gets a 400 without reaching the domain.
// Shape checks live here; business rules ("must be in the future") stay in the
// domain, which is the only place that can enforce them for every caller.
//
// Ids from the Members context are UUIDs (members-service generates them with
// randomUUID), so "format: uuid" rejects obvious garbage. Whether that member
// actually exists is a different question; see RecordAttendanceUseCase.
const memberIdSchema = { type: "string", format: "uuid" } as const;
const venueSchema = {
  type: "object",
  required: ["name"],
  properties: {
    name: { type: "string", minLength: 1 },
    address: { type: ["string", "null"] },
    isOnline: { type: "boolean" },
  },
} as const;
const eventFieldSchemas = {
  title: { type: "string", minLength: 1 },
  eventType: { type: "string", enum: EVENT_TYPES },
  venue: venueSchema,
  ministerId: { ...memberIdSchema, type: ["string", "null"] },
  scheduledAt: { type: "string", format: "date-time" },
  durationMinutes: { type: "integer", minimum: 1 },
  description: { type: ["string", "null"] },
} as const;

type VenueBody = { name: string; address?: string | null; isOnline?: boolean };
interface ScheduleBody {
  title: string;
  eventType: EventType;
  venue: VenueBody;
  ministerId?: string | null;
  scheduledAt: string;
  durationMinutes: number;
  description?: string | null;
  createdById: string;
}
type UpdateBody = Partial<Omit<ScheduleBody, "createdById">>;

export async function eventRoutes(
  app: FastifyInstance,
  opts: EventRoutesOptions = {}
): Promise<void> {
  const events = opts.events ?? new PrismaServiceEventRepository();
  const attendances = opts.attendances ?? new PrismaAttendanceRepository();
  const volunteers = opts.volunteers ?? new PrismaVolunteerAssignmentRepository();

  const scheduleEvent = new ScheduleEventUseCase(events);
  const updateEvent = new UpdateEventUseCase(events);
  const cancelEvent = new CancelEventUseCase(events, volunteers);
  const recordAttendance = new RecordAttendanceUseCase(events, attendances);
  const assignVolunteer = new AssignVolunteerUseCase(events, volunteers);

  app.post<{ Body: ScheduleBody }>(
    "/events",
    {
      schema: {
        body: {
          type: "object",
          required: [
            "title",
            "eventType",
            "venue",
            "scheduledAt",
            "durationMinutes",
            "createdById",
          ],
          // Until the Identity context exists there is no logged-in user, so
          // the caller says who is acting. That moves to the auth token later.
          properties: { ...eventFieldSchemas, createdById: memberIdSchema },
        },
      },
    },
    async (req, reply) => {
      try {
        const result = await scheduleEvent.execute({
          ...req.body,
          scheduledAt: new Date(req.body.scheduledAt),
        });
        return reply.status(201).send(result);
      } catch (err) {
        return handleError(reply, err);
      }
    }
  );

  // Public: the list of what's coming up, soonest first.
  app.get<{ Querystring: { page?: number; limit?: number } }>(
    "/events",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            page: { type: "integer", minimum: 1, default: 1 },
            limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
          },
        },
      },
    },
    async (req, reply) => {
      const page = req.query.page ?? 1;
      const limit = req.query.limit ?? 20;
      const { events: upcoming, total } = await events.listUpcoming({
        from: new Date(),
        skip: (page - 1) * limit,
        take: limit,
      });
      return reply.send({
        data: upcoming.map((e) => e.toSnapshot()),
        meta: { page, limit, total, pages: Math.ceil(total / limit) },
      });
    }
  );

  app.get<{ Params: { id: string } }>("/events/:id", async (req, reply) => {
    const event = await events.findById(req.params.id);
    if (!event) return reply.status(404).send({ error: "Event not found" });
    return reply.send(event.toSnapshot());
  });

  app.put<{ Params: { id: string }; Body: UpdateBody }>(
    "/events/:id",
    { schema: { body: { type: "object", properties: eventFieldSchemas } } },
    async (req, reply) => {
      try {
        const { scheduledAt, ...rest } = req.body;
        await updateEvent.execute(req.params.id, {
          ...rest,
          ...(scheduledAt !== undefined && { scheduledAt: new Date(scheduledAt) }),
        });
        return reply.status(204).send();
      } catch (err) {
        return handleError(reply, err);
      }
    }
  );

  // Cancelling is a state transition with its own rules and its own domain
  // event, so it gets its own endpoint instead of `PUT { status: "cancelled" }`.
  app.post<{ Params: { id: string }; Body: { reason: string } }>(
    "/events/:id/cancel",
    {
      schema: {
        body: {
          type: "object",
          required: ["reason"],
          properties: { reason: { type: "string", minLength: 1 } },
        },
      },
    },
    async (req, reply) => {
      try {
        await cancelEvent.execute(req.params.id, req.body);
        return reply.status(204).send();
      } catch (err) {
        return handleError(reply, err);
      }
    }
  );

  app.post<{
    Params: { id: string };
    Body: { memberId: string; method?: CheckInMethod; checkedInById?: string };
  }>(
    "/events/:id/attendance",
    {
      schema: {
        body: {
          type: "object",
          required: ["memberId"],
          properties: {
            memberId: memberIdSchema,
            method: { type: "string", enum: AVAILABLE_CHECK_IN_METHODS, default: "self" },
            checkedInById: memberIdSchema,
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const result = await recordAttendance.execute(req.params.id, {
          ...req.body,
          method: req.body.method ?? "self",
        });
        return reply.status(201).send(result);
      } catch (err) {
        return handleError(reply, err);
      }
    }
  );

  app.post<{
    Params: { id: string };
    Body: { memberId: string; role: VolunteerRole; assignedById: string };
  }>(
    "/events/:id/volunteers",
    {
      schema: {
        body: {
          type: "object",
          required: ["memberId", "role", "assignedById"],
          properties: {
            memberId: memberIdSchema,
            role: { type: "string", enum: VOLUNTEER_ROLES },
            assignedById: memberIdSchema,
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const result = await assignVolunteer.execute(req.params.id, req.body);
        return reply.status(201).send(result);
      } catch (err) {
        return handleError(reply, err);
      }
    }
  );
}
