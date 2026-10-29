import { inSpan } from "@cms/events";
import type { FastifyInstance, FastifyReply } from "fastify";
import { ArchiveMemberUseCase } from "../application/ArchiveMemberUseCase.js";
import { RegisterMemberUseCase } from "../application/RegisterMemberUseCase.js";
import { UpdateMemberUseCase } from "../application/UpdateMemberUseCase.js";
import { ConflictError, DomainError, NotFoundError } from "../domain/errors.js";
import type { MemberRepository } from "../domain/MemberRepository.js";
import { PrismaMemberRepository } from "../infrastructure/PrismaMemberRepository.js";

export interface MemberRoutesOptions {
  // Injectable so integration tests can supply a repository backed by a
  // throwaway database. Defaults to the Prisma-backed repository.
  repo?: MemberRepository;
}

// A span around each use case, so the trace waterfall shows the business step
// between the HTTP span and the database spans (CMS-29). Started here in the API
// layer, not in the use case: the application layer stays free of telemetry,
// like it stays free of logging. A rejected rule (e.g. a duplicate email → 409)
// marks the span as an error (inSpan does that), which is what makes TraceQL
// `{ status = error }` find it: the HTTP span itself only counts 5xx as errors.
const traced = <T>(name: string, work: () => Promise<T>): Promise<T> => inSpan(name, {}, work);

function handleError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof NotFoundError) return reply.status(404).send({ error: err.message });
  if (err instanceof ConflictError) return reply.status(409).send({ error: err.message });
  if (err instanceof DomainError) return reply.status(400).send({ error: err.message });
  throw err;
}

export async function memberRoutes(
  app: FastifyInstance,
  opts: MemberRoutesOptions = {}
): Promise<void> {
  const repo = opts.repo ?? new PrismaMemberRepository();
  const registerMember = new RegisterMemberUseCase(repo);
  const updateMember = new UpdateMemberUseCase(repo);
  const archiveMember = new ArchiveMemberUseCase(repo);

  app.post<{ Body: { name: string; email: string; phone?: string } }>(
    "/members",
    {
      schema: {
        body: {
          type: "object",
          required: ["name", "email"],
          properties: {
            name: { type: "string", minLength: 1 },
            email: { type: "string", minLength: 1 },
            phone: { type: "string" },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const result = await traced("RegisterMemberUseCase", () => registerMember.execute(req.body));
        // A business log line: says *what* happened, not just which HTTP call ran.
        // Only the id: a name or email in a log is personal data copied into a
        // system with its own retention and access rules (memberRoutes.test.ts
        // checks this). Logged here, not in the use case, because `req.log`
        // stamps the request's `reqId` on the line, and the application layer
        // has no logging port (study-guide §9.9).
        req.log.info({ memberId: result.id }, "member registered");
        return reply.status(201).send(result);
      } catch (err) {
        return handleError(reply, err);
      }
    }
  );

  app.get<{ Querystring: { page?: number; limit?: number } }>(
    "/members",
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
      const { members, total } = await repo.list({ skip: (page - 1) * limit, take: limit });
      return reply.send({
        data: members.map((m) => m.toSnapshot()),
        meta: { page, limit, total, pages: Math.ceil(total / limit) },
      });
    }
  );

  app.get<{ Params: { id: string } }>("/members/:id", async (req, reply) => {
    const member = await repo.findById(req.params.id);
    if (!member) return reply.status(404).send({ error: "Member not found" });
    return reply.send(member.toSnapshot());
  });

  app.put<{ Params: { id: string }; Body: { name?: string; phone?: string | null } }>(
    "/members/:id",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            name: { type: "string", minLength: 1 },
            phone: { type: ["string", "null"] },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        await traced("UpdateMemberUseCase", () => updateMember.execute(req.params.id, req.body));
        return reply.status(204).send();
      } catch (err) {
        return handleError(reply, err);
      }
    }
  );

  app.delete<{ Params: { id: string } }>("/members/:id", async (req, reply) => {
    try {
      await traced("ArchiveMemberUseCase", () => archiveMember.execute(req.params.id));
      return reply.status(204).send();
    } catch (err) {
      return handleError(reply, err);
    }
  });
}
