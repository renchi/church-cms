import type { FastifyInstance, FastifyReply } from 'fastify'
import { ArchiveMemberUseCase } from '../application/ArchiveMemberUseCase.js'
import { RegisterMemberUseCase } from '../application/RegisterMemberUseCase.js'
import { UpdateMemberUseCase } from '../application/UpdateMemberUseCase.js'
import { ConflictError, DomainError, NotFoundError } from '../domain/errors.js'
import { PrismaMemberRepository } from '../infrastructure/PrismaMemberRepository.js'

function handleError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof NotFoundError) return reply.status(404).send({ error: err.message })
  if (err instanceof ConflictError) return reply.status(409).send({ error: err.message })
  if (err instanceof DomainError) return reply.status(400).send({ error: err.message })
  throw err
}

export async function memberRoutes(app: FastifyInstance): Promise<void> {
  const repo = new PrismaMemberRepository()
  const registerMember = new RegisterMemberUseCase(repo)
  const updateMember = new UpdateMemberUseCase(repo)
  const archiveMember = new ArchiveMemberUseCase(repo)

  app.post<{ Body: { name: string; email: string; phone?: string } }>(
    '/members',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name', 'email'],
          properties: {
            name: { type: 'string', minLength: 1 },
            email: { type: 'string', minLength: 1 },
            phone: { type: 'string' },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const result = await registerMember.execute(req.body)
        return reply.status(201).send(result)
      } catch (err) {
        return handleError(reply, err)
      }
    },
  )

  app.get<{ Querystring: { page?: number; limit?: number } }>(
    '/members',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            page: { type: 'integer', minimum: 1, default: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          },
        },
      },
    },
    async (req, reply) => {
      const page = req.query.page ?? 1
      const limit = req.query.limit ?? 20
      const { members, total } = await repo.list({ skip: (page - 1) * limit, take: limit })
      return reply.send({
        data: members.map(m => m.toSnapshot()),
        meta: { page, limit, total, pages: Math.ceil(total / limit) },
      })
    },
  )

  app.get<{ Params: { id: string } }>('/members/:id', async (req, reply) => {
    const member = await repo.findById(req.params.id)
    if (!member) return reply.status(404).send({ error: 'Member not found' })
    return reply.send(member.toSnapshot())
  })

  app.put<{ Params: { id: string }; Body: { name?: string; phone?: string | null } }>(
    '/members/:id',
    {
      schema: {
        body: {
          type: 'object',
          properties: {
            name: { type: 'string', minLength: 1 },
            phone: { type: ['string', 'null'] },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        await updateMember.execute(req.params.id, req.body)
        return reply.status(204).send()
      } catch (err) {
        return handleError(reply, err)
      }
    },
  )

  app.delete<{ Params: { id: string } }>('/members/:id', async (req, reply) => {
    try {
      await archiveMember.execute(req.params.id)
      return reply.status(204).send()
    } catch (err) {
      return handleError(reply, err)
    }
  })
}
