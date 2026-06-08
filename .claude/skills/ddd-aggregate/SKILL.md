---
name: ddd-aggregate
description: Scaffold a new DDD aggregate root (plus its events, repository port, create use case, and unit test) inside an active Fastify+Prisma service, following this repo's layering and ACL rules. Use when the user asks to add an aggregate, entity, repository, domain event, or read model to members-service or events-service.
---

# Scaffold a DDD aggregate

This repo follows a strict layered DDD style (see `CLAUDE.md` and `docs/adr/`).
This skill lays down a new aggregate in the **exact** shape of the existing
`Member` aggregate so new contexts stay consistent.

## Before scaffolding — gate on these

1. **Active service only.** Aggregates may only go into `apps/members-service`
   or `apps/events-service`. The other contexts are deferred by **ADR-0007** —
   do not scaffold them. (The `guard-architecture` hook also blocks this.)
2. **Known invariants today.** Per CLAUDE.md, only model what has real
   invariants now. If the thing is just a field or a read model with no rules,
   say so and add a field / read model instead of an aggregate. Examples that
   are deliberately *not* aggregates: `Family` (a `familyId` field), recurring
   events (individual instances).
3. **Reference by id, never embed.** Anything from another context is an id
   field (`memberId: string`), never an imported aggregate. Display data from
   another context is a read model at the infrastructure layer, not the domain.

Confirm the **aggregate name** (PascalCase) and **target service** with the
user, then proceed.

## Steps

1. Read `templates/` in this skill folder.
2. Substitute tokens (table below) and write each file to its destination
   under `apps/<service>/src/`:

   | Template | Destination |
   |---|---|
   | `Aggregate.ts.tpl` | `domain/<Aggregate>.ts` |
   | `events.ts.tpl` | `domain/<aggregate>Events.ts` |
   | `Repository.ts.tpl` | `domain/<Aggregate>Repository.ts` |
   | `CreateUseCase.ts.tpl` | `application/Create<Aggregate>UseCase.ts` |
   | `Aggregate.test.ts.tpl` | `domain/<Aggregate>.test.ts` |

   Token substitution:

   | Token | Meaning | Example (`GroupMembership`) |
   |---|---|---|
   | `{{Aggregate}}` | PascalCase name | `GroupMembership` |
   | `{{aggregate}}` | camelCase name | `groupMembership` |

3. Fill in the `// TODO` markers with the actual fields and invariants the user
   described — do not leave a skeleton that doesn't compile against real intent.
   Validate invariants by throwing `DomainError`.
4. Tell the user the **manual follow-ups** in `reference/checklist.md` (Prisma
   model, migration, repository implementation, routes, DI wiring). Do not
   silently skip them.
5. Run `pnpm --filter <service> test` to confirm the new unit test passes.

## Rules baked into the templates

- ESM imports use the `.js` extension (NodeNext resolution).
- Aggregate has a `private constructor(private snap: Snapshot)`, getters,
  a static factory returning `{ <aggregate>, event }`, mutator methods that
  return events, `toSnapshot()`, and a static `reconstitute(snapshot)`.
- Domain events are `{ type, <aggregate>Id, occurredAt }` in a discriminated
  union (`<Aggregate>DomainEvent`).
- Repository is a **port** (interface) in `domain/`; the Prisma implementation
  lives in `infrastructure/` (see `reference/checklist.md`).
- `GroupMembership` is its own aggregate root, separate from `Group`
  (ADR-0001) — do not load memberships inside another aggregate.
