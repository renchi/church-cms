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

| Service | Context | Status |
|---------|---------|--------|
| `apps/members-service` | Members (Core Domain) | 🟢 Active — built first |
| `apps/events-service` | Events (Supporting) | 🟢 Active — second service, paired via events |
| `apps/web` | Frontend (Next.js 15) | 🟢 Active |
| `apps/identity-service` | Identity / Auth (Clerk) | ⏸️ Deferred |
| `apps/finance-service` | Finance | ⏸️ Deferred |
| `apps/communications-service` | Communications | ⏸️ Deferred |
| `apps/groups-service` | Groups | ⏸️ Deferred |

Deferred services are valuable but postponed until the Members + Events slice runs
end-to-end on Kubernetes — see [ADR-0007](docs/adr/0007-learning-scope-and-roadmap.md).

Shared packages live under `packages/` (e.g. `@cms/events` for domain event types).

## Learning roadmap

Build each stage in order; let each feel solid before the next.

1. **Members service** — Fastify + Prisma with DDD layers *(DDD in code)*
2. **Tests** for Members *(confidence to refactor)*
3. **Containerize** — Dockerfile → docker-compose *(Docker)*
4. **Frontend** wired into the compose stack
5. **Kubernetes** — minikube → manifests → Ingress → Helm *(K8s)*
6. **CI/CD** — GitHub Actions
7. **Observability** — Prometheus + Grafana *(operating distributed systems)*
8. **Events service** — repeat the DDD pattern in a second context
9. **NATS** — wire async events between Members ↔ Events *(system design)*

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
pnpm test     # Run all tests
pnpm format   # Format all files with Prettier
```

To run a single service:

```bash
pnpm --filter members-service dev
```

## Docs

Architecture Decision Records are in [`docs/adr/`](docs/adr/).
