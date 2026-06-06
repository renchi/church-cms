# Church CMS

A church management system built as a microservices monorepo using Domain-Driven Design.

## Architecture

This project follows DDD with bounded contexts mapped to independent services:

| Service | Context | Phase |
|---------|---------|-------|
| `apps/members-service` | Members (Core Domain) | 1 |
| `apps/web` | Frontend (Next.js 15) | 1 |
| `apps/identity-service` | Identity / Auth (Clerk) | 2 |
| `apps/finance-service` | Finance | 2 |
| `apps/events-service` | Events | 2 |
| `apps/communications-service` | Communications | 2 |
| `apps/groups-service` | Groups | 2 |

Shared packages live under `packages/` (e.g. `@cms/events` for domain event types).

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
