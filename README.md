# Church CMS

A church management system built as a microservices monorepo using Domain-Driven Design.

> **This is a learning project.** Its goal is to learn Docker, Kubernetes, system
> design, Domain-Driven Design, and AI-assisted development — not to ship a product
> quickly. Scope and sequencing are set deliberately in
> [ADR-0007](docs/adr/0007-learning-scope-and-roadmap.md).

## Architecture

This project follows DDD with bounded contexts mapped to independent services. To
keep the learning focused, we build a **two-service vertical slice first**
(Members + Events, wired together over a NATS message bus and deployed to
Kubernetes), then add the rest one at a time.

| Service                       | Context                 | Status                                        |
| ----------------------------- | ----------------------- | --------------------------------------------- |
| `apps/members-service`        | Members (Core Domain)   | 🟢 Active — built first                       |
| `apps/events-service`         | Events (Supporting)     | 🟢 Active — second service, paired via events |
| `apps/web`                    | Frontend (Next.js 15)   | 🟢 Active                                     |
| `apps/identity-service`       | Identity / Auth (Clerk) | ⏸️ Deferred                                   |
| `apps/finance-service`        | Finance                 | ⏸️ Deferred                                   |
| `apps/communications-service` | Communications          | ⏸️ Deferred                                   |
| `apps/groups-service`         | Groups                  | ⏸️ Deferred                                   |

Deferred services are valuable but postponed until the Members + Events slice runs
end-to-end on Kubernetes — see [ADR-0007](docs/adr/0007-learning-scope-and-roadmap.md).

Shared packages live under `packages/` (e.g. `@cms/events` for domain event types).

## Learning roadmap

Build each stage in order; let each feel solid before the next.

1. **Members service** — Fastify + Prisma with DDD layers _(DDD in code)_
2. **Tests** for Members _(confidence to refactor)_
3. **Containerize** — Dockerfile → docker-compose _(Docker)_
4. **Frontend** wired into the compose stack
5. **Kubernetes** — minikube → manifests → Ingress → Helm _(K8s)_
6. **CI/CD** — GitHub Actions
7. **Observability** — Prometheus + Grafana _(operating distributed systems)_
8. **Events service** — repeat the DDD pattern in a second context
9. **NATS** — wire async events between Members ↔ Events _(system design)_

## Prerequisites

- Node.js ≥ 20
- pnpm ≥ 9
- Docker (for local services)

## Setup

```bash
# Install all dependencies across the monorepo
pnpm install
```

## Common commands

```bash
pnpm dev      # Start all services in parallel
pnpm build    # Build all services
pnpm lint     # Lint all services
pnpm test     # Run all tests (DB-backed integration tests are skipped; see note)
pnpm format   # Format all files with Prettier
```

> **Integration tests are opt-in.** `pnpm test` runs the unit tests only; the
> Testcontainers-backed integration tests are gated behind `RUN_DB_TESTS=1` and need
> Docker running: `RUN_DB_TESTS=1 pnpm --filter members-service test`. See
> [docs/study-guide.md](docs/study-guide.md) §4 for why.

To run a single service:

```bash
pnpm --filter members-service dev
```

## Running with Docker

The Phase 1 services (members API, its Postgres database, and Adminer) run as a
local stack defined in [`docker-compose.yml`](docker-compose.yml):

```bash
cp .env.example .env        # one-time: create your local credentials file
docker compose up --build   # build + start the whole stack
```

Once it's up:

- API — <http://localhost:3001> (`curl localhost:3001/health`)
- Adminer (DB browser) — <http://localhost:8080>
- Postgres — `localhost:5432`

```bash
docker compose down         # stop; database volume survives
docker compose down -v      # stop and wipe the database volume
```

For the full workflow — plus the equivalent **raw `docker` commands** as a
learning exercise — see [docs/docker-local-dev.md](docs/docker-local-dev.md).

## Docs

- [docs/docker-local-dev.md](docs/docker-local-dev.md) — running the stack locally
  with Docker (Compose workflow + raw `docker` equivalents)
- Architecture Decision Records are in [`docs/adr/`](docs/adr/).
