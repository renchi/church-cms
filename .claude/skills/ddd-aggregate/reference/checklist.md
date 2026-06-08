# Manual follow-ups after scaffolding

The skill generates the domain + application layer. These steps wire it into the
running service and are NOT auto-generated, because they touch shared files and
the database:

1. **Prisma model** — add a `model <Aggregate>` to
   `apps/<service>/prisma/schema.prisma`. Reference other contexts as plain
   `String` id columns (e.g. `memberId String`), never a relation across a
   context boundary.
2. **Migration** — `pnpm --filter <service> exec prisma migrate dev --name add_<aggregate>`.
3. **Repository implementation** — create
   `src/infrastructure/Prisma<Aggregate>Repository.ts` implementing the
   `<Aggregate>Repository` port, mapping rows ⇄ `toSnapshot()` /
   `reconstitute()`. Mirror `PrismaMemberRepository.ts`.
4. **Read models (if needed)** — if another context needs display data from
   here, expose it as a denormalised query in `infrastructure/`, not by sharing
   the aggregate.
5. **Routes** — add `src/api/<aggregate>Routes.ts` and register it in
   `src/index.ts`, mirroring `memberRoutes.ts`.
6. **Dependency injection** — instantiate the Prisma repository and the
   `Create<Aggregate>UseCase` in `src/index.ts` and pass them to the routes.
7. **Test** — `pnpm --filter <service> test`.

## ADR cross-references

- ADR-0001 — `GroupMembership` is its own aggregate root, separate from `Group`.
- ADR-0007 — only members-service and events-service are active.
- context-map.md — ACL: reference by `memberId`; use read models for display data.
