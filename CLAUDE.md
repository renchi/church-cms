# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project purpose

This is a **learning project**. The goal is to learn Docker, Kubernetes, system design, DDD, and AI-assisted development. It is not a product to ship fast. Scope and sequencing are intentional: do not add services or complexity beyond the current learning stage (see ADR-0007).

**Learning material is a deliverable on every ticket.** Each ticket updates `docs/study-guide.md` and writes or extends a runbook. New code and YAML get explanatory comments. See `.claude/rules/docs-learning.md` for the format. Plan these deliverables up front and check them in `/verify`.

## Commands

```bash
pnpm install                          # install all workspace dependencies
pnpm dev                              # start all services in parallel
pnpm build                            # build all services
pnpm lint                             # lint all services
pnpm test                             # run all tests (integration tests need Docker — Testcontainers)
pnpm format                           # format with Prettier

pnpm --filter members-service dev        # run a single service
pnpm --filter members-service test:unit  # fast: unit tests only
pnpm --filter members-service test       # unit + integration

scripts/cluster-up.sh                    # bring up / update the whole minikube stack, then smoke-test it
scripts/cluster-up.sh --fresh            # delete the cluster first (wipes Postgres data)
scripts/cluster-up.sh --no-sudo          # agents/CI: never prompt for sudo, only check tunnel + /etc/hosts
```

## Workflow

| Step      | How                     | When                                                                                                                               |
| --------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Start     | `/start-ticket [CMS-n]` | Every session. Syncs main, reads the ticket and its ADRs, creates the `cms-{n}/{slug}` branch, and moves the ticket to In Progress |
| Plan      | Plan mode               | Tasks touching more than 2 files or making an architectural decision. The plan includes the learning deliverables                  |
| Implement | Normal editing          | After the plan is approved. A hook lints each edited `.ts` file                                                                    |
| Verify    | `/verify`               | After implementing. Proves the feature works in the running app and that the docs exist                                            |
| Review    | `/code-review`          | Before opening a PR. Fix all findings                                                                                              |
| PR        | `gh pr create`          | Reference the ticket number in the body                                                                                            |
| CI        | `gh pr checks --watch`  | All checks must be green before merge (branch protection)                                                                          |
| Ship      | Merge                   | The Deploy workflow ships changed services to minikube (`docs/ci-cd.md`). Mark the ticket Done                                     |

Never work directly on main. Scaffold new services with `/new-service`, and only for services marked Active below.

**Linear:** `Todo` is the committed queue, in board order. Tickets labelled `deferred` are out of scope (ADR-0007), so don't pick them up.

## Monorepo structure

```
apps/       # deployable services (members-service, events-service, web)
packages/   # shared packages (e.g. @cms/events for domain event types)
charts/     # one Helm chart per deployable app
k8s/        # one-off cluster manifests and add-on values (Postgres, Traefik, monitoring, ...)
scripts/    # cluster-up.sh: idempotent bootstrap that runs the k8s + observability runbooks
docs/       # learning material and runbooks (see Docs index)
docs/adr/   # architecture decision records. Read these before changing architecture
.claude/    # agent config: rules/ (path-scoped conventions), skills/, hooks/
```

- `tsconfig.base.json` is the base TS config that services extend. Target ES2022, `NodeNext` module resolution, strict mode, ESM.
- Services use **Fastify + Prisma** (members-service, events-service). The frontend uses **Next.js 15**.
- Each service's Prisma client must generate into its own folder (`output` in `schema.prisma`, as events-service does). pnpm shares one `@prisma/client`, so default outputs overwrite each other.
- Path-scoped conventions load automatically from `.claude/rules/`: `ddd.md` (service code), `k8s-helm.md` (charts, k8s, workflows, Dockerfiles), `testing.md` (tests), `docs-learning.md` (docs).

## Active vs deferred services

Only **two backend services** are in active development. Do not create or scaffold the others.

| Service                       | Status                                                                 |
| ----------------------------- | ---------------------------------------------------------------------- |
| `apps/members-service`        | Active: built first, the DDD anchor                                    |
| `apps/events-service`         | Active: second service, paired via events (scaffolded in CMS-18)       |
| `apps/web`                    | Active: Next.js 15 frontend                                            |
| `apps/identity-service`       | **Deferred**                                                           |
| `apps/finance-service`        | **Deferred**                                                           |
| `apps/communications-service` | **Deferred**                                                           |
| `apps/groups-service`         | **Deferred**                                                           |

## Architecture essentials

Full context map: [`docs/adr/context-map.md`](docs/adr/context-map.md). Details are in `.claude/rules/ddd.md`.

- **Members is the core domain.** Every other context references a `memberId`. It never duplicates person data.
- **Each context owns its own database.** One Postgres per service. No context reads another's database.
- **Anti-corruption layer:** never import another context's code. Reference it by ID. ESLint enforces this (`no-restricted-imports`).
- **Cross-context communication:** sync HTTP now. Async domain events over NATS come at stage 9: `AttendanceRecorded` (Events → Members) and `MemberArchived` (Members → Events).

## Environments

| Stage                            | Where it runs                                                                                              | Database (ADR-0008)                     |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Development                      | `pnpm dev` / docker-compose (`docs/docker-local-dev.md`)                                                   | Postgres in Docker                      |
| **Current deploy target**        | minikube, via the CI/CD Deploy workflow on a self-hosted runner (`docs/k8s-local-dev.md`, `docs/ci-cd.md`) | Postgres StatefulSet + PersistentVolume |
| Production (future, not started) | Vercel (web) · Railway/Render (services)                                                                   | Managed Postgres (Neon)                 |

Secrets come from env vars: `.env.local` locally, K8s Secrets in the cluster. Never hardcode credentials. The frontend targets mobile-first browsers: responsive Tailwind, with a PWA manifest later.

## Evolution paths

ADRs document deliberate "simple now, evolve later" decisions. When a business rule appears that was anticipated, check the relevant ADR first: the upgrade path is already designed. Don't pre-build it; implement it only when the concrete rule exists.

| Simple structure now                                                  | Trigger to evolve                                                            | ADR         |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------- |
| `familyId` field on `Member` (no `Family` aggregate)                  | Household-level invariants emerge (joint giving, head-of-household approval) | context-map |
| `Offering` covers tithes + offerings (no separate `Tithe` aggregate)  | Pledge tracking / tithe commitment analysis is prioritised                   | 0003        |
| `ServiceEvent` covers services + one-off events (no split aggregates) | Type-specific invariants appear in more than one or two places               | 0004        |
| `RecurrenceRule` absent; recurring events are individual instances    | Recurrence scheduling is explicitly prioritised                              | 0004        |
| Phase 1 uses sync HTTP between services                               | Stage 9 of the roadmap: wire NATS for async events                           | 0007        |
| OTel metrics only, Prometheus pull; no Collector or traces            | Events service + NATS live, or traces wanted                                 | 0009        |

## ADR index

| ADR  | Decision                                                             |
| ---- | -------------------------------------------------------------------- |
| 0001 | GroupMembership is a separate aggregate root                         |
| 0002 | Groups drives MinistryLeader role assignment in Identity (via event) |
| 0003 | Finance context aggregates & domain model                            |
| 0004 | Events context aggregates & domain model                             |
| 0005 | Communications context aggregates & domain model                     |
| 0006 | Groups context aggregates & domain model                             |
| 0007 | Learning scope & roadmap: two-service slice first                    |
| 0008 | Database hosting strategy (Docker → minikube → managed cloud)        |
| 0009 | Observability: OpenTelemetry instrumentation, Prometheus + Grafana   |

## Docs index

| Doc                           | What it is                                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `docs/study-guide.md`         | **The map.** Every concept learned so far, per roadmap stage, with self-check questions. Updated every ticket |
| `docs/members-service-ddd.md` | DDD layering of the reference service                                                                         |
| `docs/events-service-ddd.md`  | The second context: three aggregates, a value object, rules across aggregates                                 |
| `docs/docker-local-dev.md`    | Runbook: Compose stack, images                                                                                |
| `docs/k8s-local-dev.md`       | Runbook: minikube, Traefik, Helm deploys                                                                      |
| `docs/ci-cd.md`               | Runbook: GitHub Actions, self-hosted runner, debugging                                                        |
| `docs/observability.md`       | Runbook: Prometheus, Grafana, metrics and logs, with hands-on exercises                                       |
| `docs/status-dashboards.md`   | Where to watch the pipeline and the cluster                                                                   |
