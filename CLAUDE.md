# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project purpose

This is a **learning project** — the goal is to learn Docker, Kubernetes, system design, DDD, and AI-assisted development. It is not a product to ship fast. Scope and sequencing are intentional: do not add services or complexity beyond the current learning stage (see ADR-0007).

## Commands

```bash
pnpm install                          # install all workspace dependencies
pnpm dev                              # start all services in parallel
pnpm build                            # build all services
pnpm lint                             # lint all services
pnpm test                             # run all tests
pnpm format                           # format with Prettier

pnpm --filter members-service dev     # run a single service
pnpm --filter members-service test    # run tests for a single service
```

## Session startup

Every session — human or agent — follows this sequence before writing any code.

**Before starting:**
1. `git checkout main && git pull` — sync with remote
2. Check Linear for the next Backlog ticket — read the description and acceptance criteria
3. Read the ADR(s) relevant to the ticket (listed in the ADR index below)
4. `git checkout -b cms-{number}/{two-to-four-word-slug}` — always work on a branch, never directly on main
   - Example: `git checkout -b cms-15/traefik-ingress`
5. If the task touches more than two files or involves an architectural decision, run `/plan` before implementing

**Per-ticket loop:**

| Step | How | When |
|------|-----|------|
| Plan | `/plan` | Non-trivial tasks — architectural decisions, >2 files |
| Implement | Normal editing | After plan is approved |
| Verify | `/verify` | After implementation — confirms the feature works in the running app |
| Review | `/code-review` | Before opening a PR |
| CI | `gh pr checks --watch` | After opening a PR — all checks must be green before merge (enforced by branch protection) |

**After finishing:**
1. Run `/verify` — confirm the feature works in the running app
2. Run `/code-review` — fix all findings before proceeding
3. Mark the Linear ticket In Progress → Done
4. `gh pr create` — reference the ticket number in the PR body
5. `gh pr checks --watch` — CI must be green; after merge, the Deploy workflow ships changed services to minikube (see `docs/ci-cd.md`)

## Monorepo structure

```
apps/       # deployable services (members-service, events-service, web)
packages/   # shared packages (e.g. @cms/events for domain event types)
docs/adr/   # architecture decision records — read these before changing architecture
```

- `tsconfig.base.json` — base TS config; services extend it. Target: ES2022, `NodeNext` module resolution, strict mode.
- Services use **Fastify + Prisma** (members-service, events-service). Frontend uses **Next.js 15**.

## Active vs deferred services

Only **two services** are in active development. Do not create or scaffold the others.

| Service                       | Status                                     |
| ----------------------------- | ------------------------------------------ |
| `apps/members-service`        | Active — built first, the DDD anchor       |
| `apps/events-service`         | Active — second service, paired via events |
| `apps/web`                    | Active — Next.js 15 frontend               |
| `apps/identity-service`       | **Deferred**                               |
| `apps/finance-service`        | **Deferred**                               |
| `apps/communications-service` | **Deferred**                               |
| `apps/groups-service`         | **Deferred**                               |

## Architecture: DDD bounded contexts

The full context map is in [`docs/adr/context-map.md`](docs/adr/context-map.md). Key rules:

**Members is the core domain.** Every other context references a `memberId` — never duplicates person data.

**Each context owns its own database.** No context reads another's database directly. Two separate PostgreSQL instances (one per active service), not a shared one.

**Cross-context communication:**

- Phase 1 (now): synchronous HTTP between services
- Phase 2 (later): async domain events over NATS

**Anti-corruption layer (ACL) — enforced at all times:**

```typescript
// ✅ Reference by ID only
class Offering {
  donorMemberId: string;
}

// ❌ Never import another context's aggregate
import { Member } from "../members/domain/Member";
class Offering {
  donor: Member;
}
```

When a context needs display data from another (e.g. a donor's name on a report), use a **read model** — a denormalised query at the infrastructure layer, not the domain layer.

## Key event flows between active services

- `Events` publishes `AttendanceRecorded` → `Members` consumes it to update a member's denormalised attendance summary (total count + last seen date)
- `Members` publishes `MemberArchived` → `Events` consumes it to remove the member from future volunteer schedules

These are the two cross-service flows to implement in NATS (stage 9 of the roadmap).

## Database strategy (ADR-0008)

| Stage                 | Approach                                                                      |
| --------------------- | ----------------------------------------------------------------------------- |
| Development           | Postgres in Docker via docker-compose                                         |
| Kubernetes (minikube) | Postgres as StatefulSet with PersistentVolume — intentional, for K8s learning |
| Production (if ever)  | Managed cloud Postgres (Neon / Supabase / RDS)                                |

## DDD conventions (from ADRs)

- `GroupMembership` is a **separate aggregate root** from `Group` — no cross-membership invariants, so memberships are not loaded inside the Group aggregate.
- `Family` is **not an aggregate** in the MVP — it is a `familyId` field on `Member` and a read model only. Introduce a `Family` aggregate only when household-level invariants emerge.
- `Identity` is implemented via an external provider (Clerk or Supabase Auth) — do not build custom auth. Wrap it in a thin `IdentityService` adapter.
- Model only what has **known invariants today**. Simple structures with a documented evolution path are preferred over premature domain complexity.

## Deployment targets

| Layer                      | Service           | Notes                                                                      |
| -------------------------- | ----------------- | -------------------------------------------------------------------------- |
| Frontend (Next.js)         | Vercel            | Free tier; deploys from GitHub; the natural Next.js host                   |
| Backend services (Fastify) | Railway or Render | Free/cheap tiers; deploy from GitHub; no server management                 |
| Database (PostgreSQL)      | Neon              | Free managed Postgres; one connection string injected via env var / Secret |

This matches the "managed cloud Postgres for production" decision in ADR-0008 — Neon is the managed provider.

**Mobile access:** The app targets mobile-first browser access. Build responsive UI with Tailwind. Add a PWA manifest (`next-pwa`) so users can "Add to Home Screen" on Android and iPhone — no App Store required.

Each service receives its database connection string and any secrets via environment variables. Never hardcode credentials; use `.env.local` locally and platform secrets (Vercel env vars, Railway variables) in deployment.

## Evolution paths

ADRs document deliberate "simple now, evolve later" decisions. When a business rule appears that was anticipated, check the relevant ADR first — the upgrade path is already designed. Do not pre-build it; implement only when the concrete rule exists.

| Simple structure now                                                  | Trigger to evolve                                                            | ADR         |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------- |
| `familyId` field on `Member` (no `Family` aggregate)                  | Household-level invariants emerge (joint giving, head-of-household approval) | context-map |
| `Offering` covers tithes + offerings (no separate `Tithe` aggregate)  | Pledge tracking / tithe commitment analysis is prioritised                   | 0003        |
| `ServiceEvent` covers services + one-off events (no split aggregates) | Type-specific invariants appear in more than one or two places               | 0004        |
| `RecurrenceRule` absent; recurring events are individual instances    | Recurrence scheduling is explicitly prioritised                              | 0004        |
| Phase 1 uses sync HTTP between services                               | Stage 9 of the roadmap — wire NATS for async events                          | 0007        |

## ADR index

| ADR  | Decision                                                             |
| ---- | -------------------------------------------------------------------- |
| 0001 | GroupMembership is a separate aggregate root                         |
| 0002 | Groups drives MinistryLeader role assignment in Identity (via event) |
| 0003 | Finance context aggregates & domain model                            |
| 0004 | Events context aggregates & domain model                             |
| 0005 | Communications context aggregates & domain model                     |
| 0006 | Groups context aggregates & domain model                             |
| 0007 | Learning scope & roadmap — two-service slice first                   |
| 0008 | Database hosting strategy (Docker → minikube → managed cloud)        |
