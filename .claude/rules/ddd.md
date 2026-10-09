---
paths:
  - "apps/*-service/**"
  - "packages/**"
---

# DDD conventions for service code

Full context map: `docs/adr/context-map.md`. Reference layering: `docs/members-service-ddd.md`.

## Layering inside a service

`src/domain` ← `src/application` ← `src/infrastructure` and `src/api`

- `domain/` imports nothing from the other layers, and nothing from Fastify or Prisma. Aggregates enforce invariants; constructors stay private behind factory methods.
- `application/` holds use cases that orchestrate aggregates through repository _interfaces_.
- `infrastructure/` holds Prisma repositories and read models (denormalised queries for display data from other contexts).
- `api/` holds Fastify routes: translate HTTP to use cases and map domain errors to status codes. It holds no business rules.

## Across contexts: an anti-corruption layer, enforced at all times

```typescript
// ✅ Reference by ID only
class Offering {
  donorMemberId: string;
}

// ❌ Never import another context's aggregate
import { Member } from "../members/domain/Member";
```

- Never import from another `apps/*` package. ESLint enforces this; don't disable the rule.
- Shared contracts (domain event payloads) live in `packages/` (`@cms/events`) only.
- **Members is the core domain.** Other contexts store `memberId` and never copy person data.
- Each context owns its database. Never read another context's DB.
- Phase 1 uses synchronous HTTP between services. Phase 2 (stage 9) uses NATS events: `AttendanceRecorded` (Events → Members) and `MemberArchived` (Members → Events).

## Modelling decisions already made (from the ADRs)

- `GroupMembership` is a separate aggregate root from `Group` (ADR-0001).
- `Family` is not an aggregate. It's a `familyId` field on `Member` plus a read model.
- `Offering` covers both tithes and offerings (ADR-0003). `ServiceEvent` covers both services and one-off events, and there is no `RecurrenceRule` (ADR-0004).
- Identity comes from an external provider (Clerk or Supabase Auth) behind a thin `IdentityService` adapter. No custom auth.
- **Model only the invariants known today.** When a rule appears that an ADR anticipated, follow that ADR's evolution path (see the CLAUDE.md "Evolution paths" table). Don't pre-build it.
