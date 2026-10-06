# Study Guide — Everything Built So Far

A single document to revise from. It walks through every concept this project has
exercised, mapped to the **five learning goals** in
[ADR-0007](adr/0007-learning-scope-and-roadmap.md):

1. **Docker & containers**
2. **Kubernetes** _(stage 5 done; observability, stage 7, is next)_
3. **System design**
4. **Domain-Driven Design (DDD)** — the emphasised priority
5. **Using AI tools** — issue-driven development

This guide is the **map**. Two companion docs are the **detail**:

- [`members-service-ddd.md`](members-service-ddd.md) — the DDD layering, with diagrams
- [`docker-local-dev.md`](docker-local-dev.md) — running the stack, Compose vs. raw `docker`
- [`k8s-local-dev.md`](k8s-local-dev.md) — deploying to minikube with Helm + Traefik, step by step
- [`ci-cd.md`](ci-cd.md) — the GitHub Actions pipeline, self-hosted runner, debugging
- [`status-dashboards.md`](status-dashboards.md) — where to watch the pipeline and the cluster

Read this top to bottom once. Then, whenever a section feels thin, open the file it
points at (`file_path:line`) and read the real code — that is where the learning sticks.

---

## 0. Where we are on the roadmap

The roadmap is a 9-stage sequence. **Stages 1–6 are done.** That is the scope of this guide.

| #   | Stage                                         | Status  | What it taught                      |
| --- | --------------------------------------------- | ------- | ----------------------------------- |
| 1   | Build Members service (Fastify + Prisma, DDD) | ✅ done | DDD in code, clean architecture     |
| 2   | Tests for Members                             | ✅ done | TDD, unit vs. integration           |
| 3   | Containerize (Dockerfile → docker-compose)    | ✅ done | Docker mastery                      |
| 4   | Frontend (Next.js) + compose it in            | ✅ done | full local stack                    |
| 5   | Kubernetes (minikube → manifests → Helm)      | ✅ done | Kubernetes                          |
| 6   | CI/CD pipeline                                | ✅ done | automation                          |
| 7   | Observability (Prometheus + Grafana)          | ⬜ next | operating distributed systems       |
| 8   | Build Events service                          | ⬜      | repeat the DDD pattern              |
| 9   | Wire NATS between Members ↔ Events            | ⬜      | async events / eventual consistency |

Knowing what is **deliberately not built yet** is itself part of the learning: the
architecture is sequenced so you learn each layer once, well, instead of building the
same service six times. That decision is ADR-0007 — read it.

---

## 1. The technology stack (what each piece is and why)

Everything below is in the repo today. Know what each tool _is_ and the _one job_ it does.

| Layer         | Tool                            | Its one job                                                |
| ------------- | ------------------------------- | ---------------------------------------------------------- |
| Language      | **TypeScript** (ES2022)         | JS + static types; catches errors before runtime           |
| Monorepo      | **pnpm workspaces**             | many packages in one repo, one lockfile, shared deps       |
| API framework | **Fastify**                     | HTTP server for the backend service                        |
| ORM           | **Prisma**                      | typed database access + schema migrations                  |
| Database      | **PostgreSQL 16**               | the relational store                                       |
| Frontend      | **Next.js 15** (React 19)       | server-rendered React app (App Router)                     |
| Styling       | **Tailwind CSS 4**              | utility-class styling, mobile-first                        |
| Tests         | **Vitest** + **Testcontainers** | unit tests + real-Postgres integration tests               |
| Lint/format   | **ESLint 9** + **Prettier**     | consistency and catching mistakes                          |
| Containers    | **Docker** + **Compose**        | package and run the whole stack identically anywhere       |
| Decisions     | **ADRs** (`docs/adr/`)          | written record of _why_ each architectural choice was made |

### 1.1 The monorepo (pnpm workspaces)

The repo is one git repository holding several packages. The layout
([`pnpm-workspace.yaml`](../pnpm-workspace.yaml)):

```
apps/       # deployable services: members-service, web
packages/   # shared libraries (e.g. @cms/events) — mostly empty for now
```

Root [`package.json`](../package.json) has scripts that fan out to every package:

```bash
pnpm dev      # runs every package's "dev" in parallel
pnpm test     # runs every package's "test"
pnpm --filter members-service dev   # run just one
```

**Why a monorepo?** Two services that share types (domain event shapes) and tooling
(TS config, ESLint) live together, version together, and refactor together. pnpm stores
each dependency **once** on disk and symlinks it into each package — fast installs,
small disk footprint. The Dockerfiles have long comments about these symlinks because
they affect how files must be copied into images (see §2.3).

### 1.2 TypeScript config

[`tsconfig.base.json`](../tsconfig.base.json) is the shared base; each package extends it.
Key settings and why they matter:

- `"strict": true` — the whole point of using TS. No implicit `any`, null checks on.
- `"target": "ES2022"` — modern JS output (Node 20 supports it).
- **`NodeNext` module resolution** (set per-service) — this is why every local import
  ends in `.js` even in `.ts` files (e.g. `import { Member } from "./Member.js"` in
  [Member.ts](../apps/members-service/src/domain/errors.ts)). That trips everyone up
  once: with native ES modules, you import the _compiled output path_, not the source.

---

## 2. Docker & containers (learning goal #1)

This is the most heavily-commented part of the codebase on purpose. Companion doc:
[`docker-local-dev.md`](docker-local-dev.md). Below is the conceptual spine.

### 2.1 The core idea

A **container** is a process running in an isolated slice of the OS, with its own
filesystem, network, and dependencies — but sharing the host kernel (unlike a VM, which
boots a whole guest OS). An **image** is the read-only template a container is started
from. You build an image once; you run many containers from it.

Why it matters: the image bundles Node, your compiled code, and exactly the right
dependency versions. "Works on my machine" disappears — the image **is** the machine.

### 2.2 Multi-stage builds

Both services use a **multi-stage Dockerfile**
([members-service/Dockerfile](../apps/members-service/Dockerfile),
[web/Dockerfile](../apps/web/Dockerfile)). The pattern:

```
FROM node:20-alpine AS builder    # stage 1: install deps, compile TS, generate Prisma client
FROM node:20-alpine AS runner     # stage 2: fresh filesystem, copy ONLY the built output
```

The runner stage starts empty and copies just `dist/`, `node_modules`, and (for the API)
the Prisma schema from the builder. **Build tools and dev dependencies never reach the
shipped image** — smaller image, smaller attack surface.

Concepts to be able to explain, each commented in the Dockerfiles:

- **Layer caching** — copy `package.json` + lockfile and run `pnpm install` _before_
  copying source, so the slow install layer is reused when only code changes
  ([Dockerfile:317–331](../apps/members-service/Dockerfile#L317)).
- **`node:20-alpine`** — Alpine is a ~5 MB base vs. ~150 MB Debian. Trade-off: it uses
  `musl` libc, so Prisma's native engine needs `openssl` installed and a musl build.
- **`USER node`** — drop from root to an unprivileged user before running, so an app
  exploit doesn't grant root in the container.
- **`HEALTHCHECK`** — Docker probes `/health` on a schedule to mark the container
  healthy/unhealthy (uses Node's `http` module so no `curl` needed).
- **`ENTRYPOINT` vs. `CMD`** — `ENTRYPOINT` is the executable that always runs (here
  `tini`, a tiny init that forwards `SIGTERM` and reaps zombies); `CMD` is the default
  argument (`node dist/index.js`) and can be overridden at run time.
- **`EXPOSE`** documents a port; it does **not** publish it. Publishing happens with
  `-p host:container` or Compose `ports:`.

### 2.3 Why builds run from the monorepo root

Both Dockerfiles must be built with `context: .` (the repo root), because the build needs
the root `pnpm-lock.yaml` and `pnpm-workspace.yaml` to resolve the workspace. The runner
keeps the **same absolute path** (`/repo/apps/...`) as the builder so pnpm's symlinks
still resolve. This is a real, non-obvious consequence of using a monorepo — read the
COPY-block comments to see it spelled out.

### 2.4 Docker Compose — the whole stack with one command

[`docker-compose.yml`](../docker-compose.yml) defines five services and wires them
together. `docker compose up --build` brings up, **in dependency order**:

```
members-db  →  members-migrate  →  members-service  →  web
(postgres)     (one-shot job)      (Fastify API)        (Next.js)
                                                      + adminer (DB browser, :8080)
```

Concepts demonstrated, each commented inline:

- **Service networking by name** — inside the Compose network, `members-service` reaches
  the DB at `members-db:5432`, not `localhost`. Docker's internal DNS resolves service
  names to container IPs. This is why `DATABASE_URL` differs between Compose and your
  local `.env`.
- **`depends_on` with conditions** — not just "started" but:
  - `service_healthy` (wait for the DB's `pg_isready` healthcheck),
  - `service_completed_successfully` (wait for the migrate job to finish, exit 0),
  - `service_healthy` again (web waits for the API's `/health`).
    This removes cold-start races.
- **The migrate-then-run pattern** — migrations run as a **separate one-shot job**
  (`prisma migrate deploy`), not inside the app. The app image deliberately does not
  migrate. This maps directly to a **Kubernetes init container / Job** later (stage 5).
- **Named volumes** — `members-db-data` persists Postgres data across `down`/`up` (but
  `down -v` wipes it). State lives in volumes, not containers.
- **YAML anchors** (`x-members-base: &members-base` / `<<: *members-base`) — define the
  shared build/env block once, merge it into both the migrate job and the service.
- **Override files** — [`docker-compose.override.yml`](../docker-compose.override.yml) is
  merged automatically and swaps the web service from production `next start` to
  hot-reloading `next dev` with a source bind-mount. So plain `docker compose up` gives a
  dev experience; `docker compose -f docker-compose.yml up` gives the production-shaped one.
- **`.dockerignore`** — keeps `node_modules`, `.next`, `.env`, and tests out of the build
  context (faster builds, no secrets baked into images).

> Study tip: [`docker-local-dev.md`](docker-local-dev.md) also shows the **raw `docker`
> commands** that Compose runs for you (`docker network create`, `docker volume create`,
> `docker run ...`). Doing it by hand once is the fastest way to understand what Compose
> abstracts.

---

## 3. Domain-Driven Design (learning goal #4 — the priority)

This is the heart of the project. Full diagrams: [`members-service-ddd.md`](members-service-ddd.md).
Below is what to understand and where to see it.

### 3.1 Layered (clean) architecture

The Members service is organised in four layers under
[`apps/members-service/src/`](../apps/members-service/src). The **one rule**:
dependencies point **inward only** — inner layers never import outer ones.

```
api/             ← HTTP handlers (Fastify)            depends on → application
application/     ← use cases (orchestration)          depends on → domain
domain/          ← business rules (the core)          depends on → nothing
infrastructure/  ← Prisma, DB                          implements → domain interfaces
```

The domain has **zero** framework imports — no Fastify, no Prisma. That is what makes the
business rules testable in isolation and portable if the framework ever changes.

### 3.2 The aggregate root — `Member`

[domain/Member.ts](../apps/members-service/src/domain/Member.ts) is the **aggregate root**:
the object that owns its invariants and is the only entry point for changing them. Things
to notice in the code:

- **Private constructor + static factories.** You cannot `new Member(...)`. You call
  `Member.register({...})` to create one, or `Member.reconstitute(snapshot)` to rebuild
  one from the database. This guarantees a `Member` can never exist in an invalid state.
- **Invariants live in the domain, not the route.** `register()` rejects empty names and
  bad emails; `update()` refuses to touch an archived member; `archive()` refuses to
  double-archive. These throw `DomainError`. The HTTP layer never re-checks them.
- **Encapsulated state.** Fields are private (`snap`), exposed through getters. State only
  changes through methods that enforce rules — never by external assignment.
- **Behaviour returns domain events.** `register()` returns `{ member, event }`;
  `archive()` returns a `MemberArchivedEvent`. The aggregate _records what happened_.

### 3.3 Domain events

[domain/events.ts](../apps/members-service/src/domain/events.ts) defines
`MemberRegistered`, `MemberUpdated`, `MemberArchived` as plain typed objects. Today they
are returned in-process. **Later (stage 9)** the same shapes get published over **NATS**
so the Events service can react — e.g. `MemberArchived` → remove the member from future
volunteer schedules. Defining the events now, even unused, is deliberate: it documents the
seams where async messaging will plug in.

### 3.4 The repository pattern (dependency inversion)

The domain declares an **interface** it needs but does not implement:
[domain/MemberRepository.ts](../apps/members-service/src/domain/MemberRepository.ts) —
`findById`, `findByEmail`, `list`, `save`.

The implementation lives in infrastructure:
[infrastructure/PrismaMemberRepository.ts](../apps/members-service/src/infrastructure/PrismaMemberRepository.ts).
It translates between database rows and `Member` objects (`toMember` / `toSnapshot`) and
uses Prisma's `upsert` so one `save()` handles both insert and update.

This is **dependency inversion**: the domain depends on an abstraction it owns; the
concrete Prisma code depends on that abstraction. Swap Postgres for anything else by
writing a new class — the domain doesn't change. It also makes tests trivial: pass a fake
repository (see §4).

### 3.5 Use cases (the application layer)

Each operation is a small class in
[application/](../apps/members-service/src/application). Example:
[RegisterMemberUseCase.ts](../apps/members-service/src/application/RegisterMemberUseCase.ts)
— check email isn't taken (`ConflictError`), build the `Member` via the factory, save it.

Use cases **orchestrate**; they don't contain business rules (those are in the aggregate).
They take the repository via the constructor (dependency injection), so the same use case
runs against real Postgres in production and an in-memory fake in tests.

### 3.6 The API layer

[api/memberRoutes.ts](../apps/members-service/src/api/memberRoutes.ts) registers the REST
routes and does three things only:

1. **Validates input** with Fastify JSON schemas (shape/required fields).
2. **Calls a use case.**
3. **Maps domain errors to HTTP status codes** via `handleError`:
   `NotFoundError → 404`, `ConflictError → 409`, `DomainError → 400`.

Note [app.ts](../apps/members-service/src/app.ts): `buildApp()` constructs the Fastify
instance **without binding a port**, and accepts an injectable `repo`. That single design
choice is what makes both fast `app.inject()` unit tests and real-DB integration tests
possible from the same code.

### 3.7 Strategic DDD — bounded contexts

Beyond one service, DDD also shapes the **whole system**. The full context map is
[`docs/adr/context-map.md`](adr/context-map.md). The rules that matter:

- **Members is the core domain.** Every other context references a `memberId` — it never
  copies person data.
- **Each context owns its own database.** No service reads another's DB directly.
- **Anti-corruption layer (ACL):** reference other contexts **by ID only**; never import
  another context's aggregate. For display data (e.g. a donor's name on a report), build a
  **read model** — a denormalised query at the infrastructure layer — not a domain import.

The ADRs (`docs/adr/0001`–`0008`) record _why_ each boundary and aggregate decision was
made, including deliberate "simple now, evolve later" choices (e.g. `familyId` is a field,
not yet a `Family` aggregate). Reading an ADR before changing architecture is the habit to
build.

---

## 4. Testing (roadmap stage 2 — TDD)

Two kinds of tests live next to the code, run by **Vitest**.

- **Unit tests** — pure, fast, no I/O. Example:
  [domain/Member.test.ts](../apps/members-service/src/domain/Member.test.ts) exercises the
  aggregate's invariants directly. Use-case tests
  ([RegisterMemberUseCase.test.ts](../apps/members-service/src/application/RegisterMemberUseCase.test.ts))
  pass a **fake repository** so no database is involved.
- **Integration tests** — the real thing end-to-end. Example:
  [api/memberRoutes.integration.test.ts](../apps/members-service/src/api/memberRoutes.integration.test.ts)
  spins up a **throwaway PostgreSQL** in a container via **Testcontainers**
  (`@testcontainers/postgresql`), runs migrations against it, and drives the API through
  `app.inject()`. This proves the Prisma queries and HTTP wiring actually work, not just
  the mocks.

Why both: unit tests give fast feedback on logic; integration tests catch the seams (SQL,
serialisation, status codes) that mocks hide. The injectable `repo` and port-less
`buildApp()` from §3.6 are what make this clean.

Run them:

```bash
pnpm --filter members-service test            # unit tests (integration auto-skips)
pnpm --filter members-service test:coverage   # unit tests with coverage

# Integration tests are opt-in — they need Docker running:
RUN_DB_TESTS=1 pnpm --filter members-service test
```

**Why integration tests are opt-in.** They are gated behind the `RUN_DB_TESTS=1`
environment variable, so a plain `pnpm test` runs only the unit tests and reports the
integration ones as _skipped_. This is deliberate: the current dev host has a broken
host→container Docker network path (a connection can't complete from the host to a
container's Postgres), so the integration tests can only run in CI or on a machine where
that path works. Set `RUN_DB_TESTS=1` (with Docker running) to include them.

**In CI they always run.** The `integration-tests` job (§8) sets `RUN_DB_TESTS=1` on
GitHub's runners, which have working Docker, and also enforces the 70% coverage
thresholds. It is one of the three checks a PR must pass before it can merge.
Tracked for removal once the infra supports it: **CMS-25**.

---

## 5. The frontend (roadmap stage 4)

[`apps/web`](../apps/web) is a **Next.js 15** app using the **App Router** and **React 19**.

- [app/members/page.tsx](../apps/web/app/members/page.tsx) is a **Server Component** — it
  runs on the server, `fetch`es the member list from `members-service` at request time
  (`cache: "no-store"` for always-fresh data), validates the response shape, and renders a
  table. Because it runs server-side, it can talk to `http://members-service:3001`
  (the internal Compose DNS name); the browser never makes that call.
- **Tailwind CSS 4** for styling — utility classes, mobile-first (the CMS targets
  mobile-browser access; a PWA manifest is planned per CLAUDE.md).
- It joins the same Compose stack (stage 4); in dev the override file runs `next dev` with
  hot-reload via a bind-mount.

Concepts worth knowing: **Server vs. Client Components** (this page is a Server Component,
so no JS ships for it), and **`NEXT_PUBLIC_` env vars** (only those are inlined into
browser bundles — the Dockerfile comment explains why our server-only page doesn't need one).

---

## 6. System design (learning goal #3)

Even at two services, several distributed-systems ideas are already in play:

- **Service boundaries** — Members (core) and the soon-to-come Events service are separate
  deployables with separate databases. They communicate over the network, not shared memory.
- **Synchronous now, asynchronous later** — Phase 1 is HTTP between services (the web app
  calls the API directly). Phase 2 (stage 9) introduces **NATS** for async **domain
  events**, enabling **eventual consistency** (e.g. a member's attendance summary updates
  after the fact, not in the same request).
- **Database-per-service** — no shared database. This is what lets services evolve and
  deploy independently; the cost is you can't `JOIN` across them, which is why read models
  and events exist.
- **Health checks & readiness gating** — `/health` endpoints and Compose `depends_on`
  conditions are the same primitives Kubernetes uses for liveness/readiness probes (stage 5).
- **Migration as a separate step** — decoupling schema changes from app startup is a
  production pattern. In Compose it is a one-shot job; on Kubernetes it became an
  **init container** (§7.5).

You haven't built the async half yet — but the seams (domain events, per-service DB, health
endpoints) are deliberately in place so stage 9 is a wiring exercise, not a rewrite.

---

## 7. Kubernetes (roadmap stage 5)

The same container images from §2 now run on a local **minikube** cluster. The hands-on
runbook is [`k8s-local-dev.md`](k8s-local-dev.md); this section is the concepts.

### 7.1 The objects, and where each one lives

| Object | What it does | In this repo |
| --- | --- | --- |
| **Pod** | One or more containers scheduled together; the unit K8s runs | created by the Deployments below |
| **Deployment** | Keeps N identical Pods running; replaces them gradually on change (rolling update) | [members-service](../charts/members-service/templates/deployment.yaml), [web](../charts/web/templates/deployment.yaml), [postgres](../k8s/postgres.yaml) |
| **Service** | A stable DNS name + IP in front of changing Pods | `members-service-members-service`, `web-web`, `members-postgres` |
| **ConfigMap / Secret** | Configuration and credentials injected as env vars | [configmap.yaml](../charts/members-service/templates/configmap.yaml), [secret.yaml](../charts/members-service/templates/secret.yaml) |
| **PersistentVolumeClaim** | Disk that survives Pod restarts | Postgres data, in [k8s/postgres.yaml](../k8s/postgres.yaml) |
| **Ingress** | HTTP routing from outside the cluster to Services | [members ingress](../charts/members-service/templates/ingress.yaml), [web ingress](../charts/web/templates/ingress.yaml) |
| **HorizontalPodAutoscaler** | Adds or removes replicas based on CPU | [hpa.yaml](../charts/members-service/templates/hpa.yaml) (2–5 replicas) |

The habit to build: **you don't start containers, you declare the desired state** and
the cluster keeps reconciling towards it. Delete a Pod and the Deployment makes a new one.

### 7.2 Helm — templated, versioned deploys

A **chart** ([charts/members-service](../charts/members-service)) is a folder of
templated manifests plus [`values.yaml`](../charts/members-service/values.yaml) defaults.
`--set image.tag=…` overrides a value per deploy, which is how the same chart deploys
`members-service:local` by hand and `ghcr.io/…:<sha>` from CI.

- `helm upgrade --install` is idempotent: it installs the first time and upgrades after that.
- Every deploy is a numbered **release revision**: `helm history members-service`, and
  `helm rollback members-service <rev>` to go back.

### 7.3 Probes — how K8s knows a Pod is healthy

- **Readiness** (`/health`): "send me traffic yet?" A Pod that isn't Ready is taken out
  of the Service, and a rolling update waits for new Pods to be Ready before removing the
  old ones. This is what makes a bad deploy stop instead of taking the site down.
- **Liveness** (`/health`): "am I stuck?" Failing it repeatedly makes K8s **restart**
  the container.

These are the Kubernetes version of the Compose healthchecks from §2.4.

### 7.4 Ingress with Traefik

**Traefik** is the Ingress *controller*, the actual proxy that reads Ingress objects.
`cms.local/api/members/*` goes to members-service and `cms.local/*` goes to web. A Traefik
**StripPrefix** [middleware](../charts/members-service/templates/middleware.yaml) removes
`/api/members`, so the service still sees plain `/health` and `/members`. Locally,
`minikube tunnel` plus an `/etc/hosts` entry makes `cms.local` reachable.

### 7.5 Migrations as an init container

An **init container** runs to completion *before* the app container starts. The
members-service Pod has one called `migrate` that runs `prisma migrate deploy`
([deployment.yaml](../charts/members-service/templates/deployment.yaml)). If it fails, the
Pod never becomes Ready, so a broken migration stops the rollout.

- **Safe across replicas:** each replica runs it, and Prisma takes a Postgres advisory
  lock, so only one applies changes; the rest find "No pending migrations".
- **Rollbacks don't undo schemas.** If new Pods fail after migrating, Helm rolls back the
  *image* but not the *database*. So every migration must also work with the previous
  release: the **expand/contract** pattern. Add first, remove a release later. The table
  is in [ci-cd.md](ci-cd.md#migrations-and-rollbacks-expandcontract).
- **Why not a Helm hook Job?** The DB Secret is created by the same chart, and a
  `pre-install` hook would run before the Secret exists.

### 7.6 Known gaps (deliberate or not yet done)

- **Postgres runs as a Deployment + PVC, not a StatefulSet** as ADR-0008 describes.
  It works for a single dev instance. A StatefulSet adds stable identity and per-replica
  volumes, which matter once a database has replicas.
- **The HPA can't scale yet.** It needs CPU metrics, and minikube's `metrics-server`
  addon is disabled, so the HPA logs `FailedGetResourceMetric` and stays at 2 replicas.
  `minikube addons enable metrics-server` fixes it, which fits stage 7 (observability).
- **Dev credentials live in the chart's Secret template.** That's fine for local
  learning. Real deployments inject them from outside (platform secrets, External
  Secrets, Sealed Secrets).

---

## 8. CI/CD (roadmap stage 6)

Two GitHub Actions workflows: **CI** proves a change is good, and **CD** ships it. Full setup
and debugging: [`ci-cd.md`](ci-cd.md). Visual overview: the pipeline diagram page shared
from CMS-16.

### 8.1 CI — every pull request

[`ci.yml`](../.github/workflows/ci.yml) runs three jobs in parallel on GitHub's machines:

- `lint-typecheck`: lint, Prisma client generation, typecheck, build
- `unit-tests`
- `integration-tests`: real Postgres via Testcontainers, plus the coverage gate

**Branch protection** on `main` lists those three as *required checks*. While any is
red, GitHub marks the PR `BLOCKED` and the merge button is disabled, for admins too.
`strict` mode also requires the branch to be up to date with `main`, so what was
tested is what gets merged. This was verified with a deliberately failing test.

### 8.2 CD — after a merge

[`deploy.yml`](../.github/workflows/deploy.yml) does not run on the push itself. It is
**chained to CI** with `workflow_run`: it starts only when CI has passed on `main`. Two PRs
can each pass alone and still break when combined, and this catches that.

1. `changes` diffs the merge commit against its parent and picks the services whose
   `apps/<svc>` or `charts/<svc>` changed.
2. `deploy` (one job per service) runs `docker build`, then `docker push` to
   `ghcr.io/renchi/church-cms/<svc>:<commit-sha>`, then
   `helm upgrade --install --wait --rollback-on-failure`.

Tagging by **commit SHA** (not `latest`) means every deploy is a real change that
Kubernetes rolls out, and `kubectl get deploy -o jsonpath='{..image}'` tells you exactly
which commit is running. First measured run: **2 min 37 s from merge to both services live.**

### 8.3 Why a self-hosted runner

minikube's API is on a private IP, and GitHub's cloud machines can't reach it. So a
**runner** (GitHub's job agent) is installed on the same machine as a systemd service. It
makes outbound HTTPS calls only, uses the local Docker and `~/.kube/config`, and builds
native arm64 images.

Because the repo is public, the security rules matter:

- Deploy has **no `pull_request` trigger**, so code from a PR never runs on your machine.
- It only accepts CI runs that were a `push`, from this repository, and passed.
- Workflows from outside contributors' forks need manual approval.

### 8.4 What setting it up taught (real problems we hit)

| Problem | Lesson |
| --- | --- |
| `pnpm lint` crashed: pnpm had resolved **ESLint 10** for the web app | CI exposes dependency drift you never notice locally; pin what you rely on |
| Typecheck passed without a generated Prisma client (`PrismaClient` was `any`) | A green check is only as strong as what it really checks |
| CI jobs "cancelled — not acquired by Runner" | That was a GitHub outage, not our code. Read the reason before debugging |
| Pods `ImagePullBackOff` / `unauthorized` | Private registry images need credentials, so we made the packages public |
| Helm 4 warning: `--atomic` deprecated | Watch tool deprecations in logs; renamed to `--rollback-on-failure` |
| The ticket said "kubeconfig secret" | Tickets can be wrong about *how*. Keep the *goal* and record the deviation (PR + Linear comment) |

---

## 9. Using AI tools (learning goal #5)

The development method itself is a learning goal: **issue-driven development with Claude
Code + Linear**. Each chunk of work maps to a Linear ticket (CMS-5, CMS-6, CMS-12 …, visible
in the roadmap table and git history). The workflow:

1. A ticket defines a small, reviewable slice of work.
2. Claude Code implements it against the existing code and conventions.
3. Decisions that shape architecture are written down as **ADRs**, not left in chat.
4. Code is heavily commented **for learning**, not just for shipping.
5. Every ticket goes through the same **quality loop**: plan → implement → verify in the
   running app → `/code-review` (fix every finding) → PR → CI green → merge. On CMS-16,
   the review caught two real bugs: deploy didn't wait for CI, and typecheck ignored the
   Prisma types.

The takeaway as a modern developer: AI tools are most effective when scoped by clear
tickets, anchored by written decisions (ADRs), and verified by tests — exactly the loop
this repo models.

---

## 10. Self-check — can you explain each of these?

If you can answer these from memory, you've absorbed what's been built. If not, the section
in parentheses (and the file it links) is where to look.

**Docker**

- [ ] What does a multi-stage build save you, concretely? (§2.2)
- [ ] Why copy `package.json` before the source code? (§2.2 layer caching)
- [ ] How does `members-service` find the database — and why not `localhost`? (§2.4)
- [ ] What do the three `depends_on` conditions each wait for? (§2.4)
- [ ] Why run migrations as a separate job instead of in the app? (§2.4)

**DDD**

- [ ] Why is `Member`'s constructor private? (§3.2)
- [ ] Where do business invariants live, and where do they _not_? (§3.2, §3.6)
- [ ] What is the repository pattern buying you? (§3.4)
- [ ] Difference between a use case and the aggregate? (§3.2 vs §3.5)
- [ ] What is the ACL rule, and what's a read model? (§3.7)

**Stack & system design**

- [ ] What problem do pnpm workspaces solve? (§1.1)
- [ ] Why `.js` extensions in TypeScript imports? (§1.2)
- [ ] Unit vs. integration test — what does each catch that the other misses? (§4)
- [ ] What is a Next.js Server Component, and why no JS ships for the members page? (§5)
- [ ] What changes at stage 9 (NATS), and what's already in place for it? (§3.3, §6)

**Kubernetes**

- [ ] Deployment vs. Pod vs. Service: which one gives you a stable address? (§7.1)
- [ ] What does `helm upgrade --install --set image.tag=…` change, and how do you undo it? (§7.2)
- [ ] Readiness vs. liveness: which one stops a bad rollout, and which restarts a container? (§7.3)
- [ ] Why does `/api/members/health` reach the service as `/health`? (§7.4)
- [ ] Why must migrations be backward compatible when the image can be rolled back? (§7.5)
- [ ] Why isn't the HPA scaling right now? (§7.6)

**CI/CD**

- [ ] What makes a red test actually block the merge? (§8.1)
- [ ] Why does Deploy wait for CI on `main` instead of running on the push? (§8.2)
- [ ] Why tag images with the commit SHA instead of `latest`? (§8.2)
- [ ] Why can't GitHub's cloud runners deploy to minikube, and how is the self-hosted runner kept safe? (§8.3)

---

## 11. Where to go next

The next stage is **Observability** (roadmap stage 7): Prometheus to collect metrics,
Grafana to see them, plus structured logs. Stages 5–6 left natural starting points:
enabling `metrics-server` so the HPA finally works (§7.6), the `/health` endpoints, and
the deploy summaries CI already writes. After that, stage 8 repeats the DDD pattern in the
Events service, and it gets the CI/CD pipeline for free by following the same folder
conventions (`apps/<svc>`, `charts/<svc>`).

Read, in this order, to go deeper than this guide:

1. [`members-service-ddd.md`](members-service-ddd.md) — DDD with full diagrams
2. [`docker-local-dev.md`](docker-local-dev.md) — the container workflow, hands-on
3. [`k8s-local-dev.md`](k8s-local-dev.md) — the Kubernetes deploy, hands-on
4. [`ci-cd.md`](ci-cd.md) — the pipeline, runner setup and debugging
5. [`adr/0007-learning-scope-and-roadmap.md`](adr/0007-learning-scope-and-roadmap.md) — the why behind the sequencing
6. [`adr/context-map.md`](adr/context-map.md) — the strategic DDD picture
