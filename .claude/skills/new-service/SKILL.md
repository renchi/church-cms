---
name: new-service
description: Scaffold a new backend service (bounded context) so it matches members-service exactly — layered src, Prisma, Dockerfile, Helm chart, own Postgres, compose, CI/deploy wiring, docs. Use only for services marked Active in CLAUDE.md.
argument-hint: "<service-name, e.g. events-service>"
disable-model-invocation: true
---

# Scaffold a new service

**Guard first:** the service must be marked **Active** in the CLAUDE.md "Active vs deferred services" table. If it's deferred, stop and tell the user (ADR-0007).

`apps/members-service` is the reference implementation. Copy its _structure and conventions_, not its domain. Read the context's ADR (e.g. ADR-0004 for Events) and `docs/adr/context-map.md` before modelling anything. Model only invariants that are known today.

Plan this in plan mode first: it touches many files.

## Checklist (each item mirrors an existing file for members-service)

**App** in `apps/<svc>/`:

- [ ] `package.json` with the same scripts (`dev`, `build`, `start`, `lint`, `typecheck`, `test`, `test:unit`, `test:coverage`). CI fails if `test:unit` is missing.
- [ ] `tsconfig.json`, `prisma/schema.prisma`, `.env.example`
- [ ] `src/domain/` (aggregates, repository interface, errors, events), `src/application/` (use cases), `src/infrastructure/` (Prisma repo), `src/api/` (routes), `src/app.ts` (`buildApp()`), `src/index.ts`
- [ ] Observability, the same as members-service: `src/instrumentation.ts` (OTel, Prometheus exporter on its own port), JSON logger with a `service` base field, and `/health` silenced
- [ ] Unit tests next to the domain and use cases. Integration tests named `*.integration.test.ts` (Testcontainers).
- [ ] Unique port (members uses 3001)

**Cross-context rules:**

- [ ] No import from another `apps/*`. The ESLint `no-restricted-imports` rule enforces this. Shared event types go in `packages/` (`@cms/events`).
- [ ] Other contexts referenced by ID only (`memberId: string`)

**Container and local dev:**

- [ ] `apps/<svc>/Dockerfile`: copy the members-service multi-stage Dockerfile, keeping its teaching comments
- [ ] `docker-compose.yml`: its own `<svc>-db` Postgres, a migrate job, and the service (ADR-0008: one DB per service)

**Kubernetes:**

- [ ] `charts/<svc>/`: copy `charts/members-service` (deployment with a migrations init container, service, configmap, secret, hpa, ingress, middleware, servicemonitor). Ingress path `/api/<context>`.
- [ ] Postgres for the service: a StatefulSet and PVC like `k8s/postgres.yaml`
- [ ] Grafana: the RED dashboard's "Service" dropdown picks up the new `job` automatically (via `target_info`). Check that it appears
- [ ] `scripts/cluster-up.sh`: add the new Postgres, the image build and the `helm upgrade --install` (with `metrics.serviceMonitor.enabled=true`), plus a smoke-test line for the new health endpoint

**CI/CD:**

- [ ] `.github/workflows/deploy.yml`: add a paths-filter entry and add the service to the services list
- [ ] `.github/workflows/ci.yml`: add the `prisma generate` step and the integration test job for the new package
- [ ] `Dockerfile`s of other services: add the new `package.json` COPY line if the lockfile install needs it

**Docs** (per `.claude/rules/docs-learning.md`):

- [ ] `docs/<svc>-ddd.md` like `docs/members-service-ddd.md`
- [ ] Update `docs/k8s-local-dev.md` (build and deploy steps) and `docs/study-guide.md` (new section, roadmap §0, self-check)
- [ ] Update the CLAUDE.md service table and docs index

Finish with `/verify`.
