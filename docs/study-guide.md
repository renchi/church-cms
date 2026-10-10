# Study Guide — Everything Built So Far

A single document to revise from. It walks through every concept this project has
exercised, mapped to the **five learning goals** in
[ADR-0007](adr/0007-learning-scope-and-roadmap.md):

1. **Docker & containers**
2. **Kubernetes** _(stages 5 and 7 done: cluster, Helm, observability)_
3. **System design**
4. **Domain-Driven Design (DDD)** — the emphasised priority _(stage 8 done: a second bounded context)_
5. **Using AI tools** — issue-driven development

This guide is the **map**. The companion docs are the **detail**:

- [`members-service-ddd.md`](members-service-ddd.md) — the DDD layering, with diagrams
- [`events-service-ddd.md`](events-service-ddd.md) — the second context: several aggregates, a value object, cross-aggregate rules
- [`docker-local-dev.md`](docker-local-dev.md) — running the stack, Compose vs. raw `docker`
- [`k8s-local-dev.md`](k8s-local-dev.md) — deploying to minikube with Helm + Traefik, step by step
- [`ci-cd.md`](ci-cd.md) — the GitHub Actions pipeline, self-hosted runner, debugging
- [`status-dashboards.md`](status-dashboards.md) — where to watch the pipeline and the cluster
- [`observability.md`](observability.md) — Prometheus, Grafana, metrics and logs, with exercises

Read this top to bottom once. Then, whenever a section feels thin, open the file it
points at (`file_path:line`) and read the real code — that is where the learning sticks.

---

## 0. Where we are on the roadmap

The roadmap is a 9-stage sequence. **Stages 1–8 are done.** That is the scope of this guide.

| #   | Stage                                         | Status  | What it taught                      |
| --- | --------------------------------------------- | ------- | ----------------------------------- |
| 1   | Build Members service (Fastify + Prisma, DDD) | ✅ done | DDD in code, clean architecture     |
| 2   | Tests for Members                             | ✅ done | TDD, unit vs. integration           |
| 3   | Containerize (Dockerfile → docker-compose)    | ✅ done | Docker mastery                      |
| 4   | Frontend (Next.js) + compose it in            | ✅ done | full local stack                    |
| 5   | Kubernetes (minikube → manifests → Helm)      | ✅ done | Kubernetes                          |
| 6   | CI/CD pipeline                                | ✅ done | automation                          |
| 7   | Observability (Prometheus + Grafana)          | ✅ done | operating distributed systems       |
| 8   | Build Events service                          | ✅ done | repeat the DDD pattern              |
| 9   | Wire NATS between Members ↔ Events            | ⬜ next | async events / eventual consistency |

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

Stage 8 put these rules to work with a second context, Events: see §10.

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
pnpm --filter members-service test            # everything: unit + integration (needs Docker)
pnpm --filter members-service test:unit       # unit tests only: fast, no Docker
pnpm --filter members-service test:coverage   # everything, with the 70% coverage gate
```

**The same split in CI** (§8): the `unit-tests` job runs `test:unit`, and the
`integration-tests` job runs `test:coverage` (unit + integration + coverage
thresholds). Both are required checks before a PR can merge.

**History: they used to be opt-in.** Until CMS-25, the integration tests were gated
behind a `RUN_DB_TESTS=1` environment variable. The dev host had a broken
host→container Docker network path: a connection to a container's Postgres would
start but never complete. Once that was fixed (verified with three clean local runs),
the gate was removed, so a plain `pnpm test` locally runs exactly what CI runs. The
lesson: an environment workaround should come with a ticket to remove it, otherwise it
quietly becomes permanent.

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
- ~~**The HPA can't scale yet.**~~ Fixed in stage 7: it needed CPU metrics from
  minikube's `metrics-server` addon, which was disabled. Now `kubectl get hpa` shows
  `cpu: 2%/70%` (§9.7).
- **Dev credentials live in the chart's Secret template.** That's fine for local
  learning. Real deployments inject them from outside (platform secrets, External
  Secrets, Sealed Secrets).

### 7.7 Automating the runbook: an idempotent bootstrap script

Bringing the cluster up by hand means ~15 steps across two runbooks, and the details are easy to
get wrong: the Traefik flags, the install order, waiting for things to be ready. The
[`scripts/cluster-up.sh`](../scripts/cluster-up.sh) script runs those steps for you. It's built
on a few ideas that apply to any infrastructure automation.

**Idempotent = safe to run again.** Running it once or five times ends in the same state. That
comes from using *declarative* commands that say what should exist, rather than *imperative*
ones that say "create this":

| Command | Second run | Why |
| --- | --- | --- |
| `helm install traefik …` (the old runbook) | ❌ fails: *cannot re-use a name* | "create" can't succeed twice |
| `helm upgrade --install traefik …` | ✅ upgrades to the same values | installs if missing, otherwise brings it to the declared state |
| `kubectl apply -f k8s/postgres.yaml` | ✅ prints `unchanged` | compares the desired with the live object, and changes only differences |
| `minikube start` / `addons enable` | ✅ no-op if already done | |

A run from nothing (`--fresh`) took ~4.7 min, most of it image builds. A re-run takes ~26 s and restarts nothing. Helm still records a new *revision*
(`helm history`), but because the rendered Pod spec is identical, the Deployment doesn't roll.

**Pin versions** (`--version 41.6.1`, `--version 92.2.0`). Without a pin, "the same script" installs
whatever the latest chart is on the day you run it. Pinning makes a run months later reproduce what was tested.

**Order is a dependency graph.** The monitoring stack installs the `ServiceMonitor` **CRD**, and
the members-service chart *uses* that CRD. So monitoring must come before the apps, or the app
install fails with *no matches for kind "ServiceMonitor"*. Similarly, Postgres must be ready
before members-service's migration init container runs.

**Wait for readiness, then prove it works.** `--wait` and `kubectl rollout status` block until
Pods are Ready. The script ends with a **smoke test** (health endpoint, web, Grafana, Prometheus
targets) because "the commands succeeded" isn't the same as "the system works".

**Automating root steps: visibly, narrowly, reversibly.** `minikube tunnel` and `/etc/hosts`
both need `sudo`. The first version only *checked* them, on the reasoning that a script which
silently edits system files is a script people stop trusting. But every `--fresh` gives
Traefik a **new IP**, so that left a manual step after every rebuild. The script now does both,
under rules that keep it trustworthy:

- It uses sudo **only when something is wrong**. A healthy run never asks for a password.
- It **shows the diff** before changing `/etc/hosts`, and saves a backup (`/etc/hosts.church-cms.bak`).
- It owns **one marked block** (`# BEGIN church-cms` … `# END church-cms`). Old lines for our
  names are removed, and every other line stays byte-for-byte. This was tested on a copy,
  including a line that mixes our names with others.
- It starts the tunnel **in the background** (`nohup … &`, log in `/tmp/minikube-tunnel.log`).
- **`--no-sudo`** brings back check-only mode, for CI or an agent that can't type a password.

The trade-off changed because the cost of the manual step changed. That's worth noticing:
"don't automate X" is rarely a permanent rule.

**Script + runbook, not script instead of runbook.** Each step prints its runbook section
(`==> [k8s-local-dev §2]`). The runbook explains *why*; the script makes it *repeatable*. When
they disagree, that's a bug in one of them.

What setting it up taught:

| Problem | Lesson |
| --- | --- |
| The minikube node was capped at **3 GB** and already using ~2.7 GB. Earlier planning had said "~7 GB free, no bump needed" | `free` *inside* the node shows the host's RAM. The real cap is on the container: `docker inspect minikube --format '{{.HostConfig.Memory}}'`. New clusters now get `--memory 6g`. The cap can only be set at creation |
| The old runbook used `helm install`, so it couldn't be re-run | Prefer declarative, idempotent commands (`upgrade --install`, `apply`) everywhere, not only in scripts |
| Moving Traefik's `--set` flags into `k8s/traefik-values.yaml` could silently change it | `diff <(helm template … -f values) <(helm template … --set …)` proved the two render identically before switching |
| Helm prints long NOTES after every install, which buried the useful output | Filter to the `STATUS` line, while `set -o pipefail` keeps Helm's failures fatal (tested by pointing it at a missing chart) |
| On the first `--fresh` run, minikube warned that v1.39+ defaults to the **containerd** runtime | Our image builds depend on `minikube docker-env`, which needs the Docker runtime. Pin what you depend on (`--container-runtime docker`), just like chart versions. Read warnings in the output: they're tomorrow's failures |
| After `sudo pkill -f "minikube tunnel"`, the script said the tunnel was fine, and it *was* still working | Two things outlive the tunnel: the IP recorded on the Traefik Service, and the route `10.96.0.0/12 via 192.168.49.2` the tunnel added (gone after a reboot). Test **behaviour** ("can I reach Traefik?"), not a status field that only reports what was last true |
| `--skip-build` could quietly deploy an old image (`members-service:local` was 4 days old, from before OTel) | The script prints each reused image's build time. Fast paths need visible warnings |

Next steps for this idea (not needed yet): `make` targets, **helmfile** (declare all Helm releases
in one file), or **Tilt**/**Skaffold** (rebuild and redeploy on every code change).

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

## 9. Observability (roadmap stage 7)

Until now the only way to know whether the system was healthy was to `curl` it. For
**observability** you instead ask the running system questions you didn't plan for in
advance: *"is it slow?", "since when?", "only on one route?", "which Pod?"* This stage adds
the tools to answer those from the outside, without attaching a debugger.

Runbook (install, use, troubleshoot, exercises): [`observability.md`](observability.md).
The decision record: [ADR-0009](adr/0009-observability-opentelemetry.md).

### 9.1 The three pillars, and which ones we have

| Signal | Answers | Example | Here |
| --- | --- | --- | --- |
| **Metrics** | *How much / how often / how fast*, as numbers over time. Cheap to store, great for graphs and alerts | 0.86 req/s, p95 = 7 ms | ✅ Prometheus + Grafana |
| **Logs** | *What exactly happened* in one event | `{"reqId":"req-e","res":{"statusCode":404}}` | ✅ JSON on stdout, `kubectl logs` |
| **Traces** | *Where did the time go* as one request crosses services | members → events → NATS | ⏳ with Events (stage 8/9) |

You usually start from a **metric** (error rate went up), narrow it with **labels** (only
`/members/:id`, only 404s), then read the **logs** for those requests. Traces join that
up across services, which is why they wait until there *is* a second service.

### 9.2 OpenTelemetry: instrumentation separate from the backend

**OpenTelemetry (OTel)** is a vendor-neutral standard for *producing* telemetry. Its parts:

| Part | What it is | In this repo |
| --- | --- | --- |
| **API** | The interfaces code calls ("record this duration") | `@opentelemetry/api` |
| **SDK** | The implementation: aggregates measurements, holds config | `NodeSDK` in [`instrumentation.ts`](../apps/members-service/src/instrumentation.ts) |
| **Instrumentation** | Libraries that measure *other* libraries for you by patching them | `instrumentation-http` (durations), `@fastify/otel` (route names) |
| **Exporter** | Sends or serves the data in some backend's format | `PrometheusExporter`, serving `:9464/metrics` |
| **Collector** | Optional separate process that receives, processes and fans out telemetry | not yet (ADR-0009) |

The point of the split: **services describe *what* happened; the backend is a
configuration choice.** Switching from Prometheus to another vendor, or adding traces,
changes the exporter in one file and leaves the instrumented code alone. The ticket
suggested a Fastify-Prometheus plugin. That would have welded the two together, so
we kept the *goal* (Prometheus + Grafana) and changed the *how* (§8.4's lesson again).

**Loading order matters.** Instrumentation works by patching `http` and `fastify` *as
they're loaded*, so the SDK must start first. That's why the container runs
`node --import ./dist/instrumentation.js dist/index.js` ([Dockerfile](../apps/members-service/Dockerfile))
instead of importing it from `index.ts`. And because the service is ESM, the Fastify
plugin is registered explicitly in [`app.ts`](../apps/members-service/src/app.ts) rather
than relying on automatic patching ([`fastifyOtel.ts`](../apps/members-service/src/infrastructure/fastifyOtel.ts)).

### 9.3 Prometheus: pull, time series, labels

Prometheus **pulls** ("scrapes"): every 15 s it does `GET /metrics` on each target and
stores the numbers with a timestamp. Pull means the app needs no idea where Prometheus
is, and a target that stops answering becomes an alert in itself (`up == 0`).

A **time series** is one metric name plus one unique set of **labels**:

```
http_server_request_duration_count{job="members-service", http_route="/members/:id", http_response_status_code="404"}  10
```

The three metric types:

- **Counter**: only goes up (total requests). On its own the value means little; you
  graph its *rate*.
- **Gauge**: goes up and down (memory in use, queue length).
- **Histogram**: a family of counters, one per **bucket** (`_bucket{le="0.005"}`,
  `le="0.01"` … `le="+Inf"`), plus `_count` and `_sum`. Each bucket counts the requests
  that took *at most* that long, which lets you estimate percentiles later. Our
  `http_server_request_duration` is one, in seconds, with buckets from 5 ms to 10 s.

**Cardinality.** Every distinct label combination is a separate series, held in memory.
If the label were the raw URL (`/members/7f3a…`), every member id would create new
series without limit, and Prometheus would eventually fall over. So the label is the
**route template** `/members/:id`, which `@fastify/otel` supplies. The test
[`instrumentation.test.ts`](../apps/members-service/src/instrumentation.test.ts) asserts
exactly this: two different ids, one series.

### 9.4 The Prometheus Operator and ServiceMonitors

Nobody edits `prometheus.yml` here. kube-prometheus-stack installs the **Prometheus
Operator**, which adds a custom resource (CRD) called **ServiceMonitor**. Our chart ships
one ([`servicemonitor.yaml`](../charts/members-service/templates/servicemonitor.yaml)):
*"scrape the Service with these labels, on its port named `metrics`, every 15 s."* The
Operator watches for ServiceMonitors and regenerates Prometheus's config. That's the
Kubernetes **operator pattern**: you declare what you want, and a controller makes it so.

Three details that bite:

- Prometheus only picks ServiceMonitors labelled **`release: kube-prometheus-stack`**.
  Without that label, nothing happens and no error shows anywhere.
- The ServiceMonitor follows the **Service**, so Prometheus discovers every Pod behind it
  automatically. New Pods from a rollout or the HPA are scraped with no change.
- The CRD must exist before a chart can create a ServiceMonitor. That's why the flag
  `metrics.serviceMonitor.enabled` defaults to `false` and deploy.yml turns it on
  (`.claude/rules/k8s-helm.md`).

`/metrics` is on its **own port (9464)**. The Ingress routes only the `http` port, so
internal numbers never become public at `cms.local`.

### 9.5 The RED method, and reading the dashboard's PromQL

For any request-driven service, three numbers tell you most of what matters. This is
the **RED method**: **R**ate, **E**rrors, **D**uration. The dashboard
([`service-red-dashboard.yaml`](../k8s/monitoring/service-red-dashboard.yaml)) is built
around it:

```promql
# Rate: requests per second, per route
sum by (http_route) (rate(http_server_request_duration_count{job="members-service"}[$__rate_interval]))
```

- `rate(counter[window])` is the per-second increase over the window. It turns
  "10 432 requests ever" into "0.86 per second now", and it copes with counter resets
  when a Pod restarts.
- `sum by (http_route)` adds the Pods together (2 replicas → 1 line), keeping only the
  route label.
- `$__rate_interval` is Grafana picking a window safely larger than the scrape interval.
  `rate` needs at least two samples.

```promql
# Errors: 5xx share of all requests
(sum(rate(..._count{job="members-service", http_response_status_code=~"5.."}[$__rate_interval])) or vector(0))
  / sum(rate(..._count{job="members-service"}[$__rate_interval]))
```

`=~"5.."` is a regex match. `or vector(0)` turns "no 5xx series at all" into 0 instead
of "No data". The dashboard shows 4xx separately: a 404 is the client's mistake, a 500
is ours. Only the second should page someone.

```promql
# Duration: p95 latency
histogram_quantile(0.95, sum by (le) (rate(http_server_request_duration_bucket{job="members-service"}[$__rate_interval])))
```

`histogram_quantile` estimates the value below which 95% of requests fall, from the
bucket rates (`le` must survive the `sum by`). **Why p95 rather than the average?**
Averages hide the slow tail. If 1 request in 20 takes 2 s, the average looks fine
while every 20th user waits. p50/p95/p99 show the typical case and the tail.

### 9.6 Structured logging

Fastify's logger (pino) writes **one JSON object per line** to stdout. Kubernetes keeps
stdout per container, and `kubectl logs` reads it. JSON makes the logs *queryable*
(`jq 'select(.res.statusCode >= 400)'`) instead of grep-able. What we configured in
[`app.ts`](../apps/members-service/src/app.ts):

- `base: { service: "members-service" }` on every line, so mixed logs from several
  services stay attributable.
- `level` from `LOG_LEVEL` (ConfigMap, `values.yaml` → `config.logLevel`). Pino levels are
  numbers: 30 info, 40 warn, 50 error.
- `/health` has `logLevel: "silent"`. Probes every few seconds from 2 Pods would drown
  the real requests. They're excluded from the metrics too.
- Fastify adds a `reqId` to every line of a request, so you can follow one request through
  its lines. Traces later extend that idea across services.

### 9.7 metrics-server vs. Prometheus: two different metrics systems

| | metrics-server | Prometheus |
| --- | --- | --- |
| Data | Current CPU/memory per Pod, no history | Any metric your apps expose, with history |
| Used by | `kubectl top`, **HPA** | Grafana dashboards, alerts |
| Installed by | `minikube addons enable metrics-server` | kube-prometheus-stack |

The HPA from §7.6 never worked because metrics-server was off. It logged
`FailedGetResourceMetric` for days. Enabling it fixed the HPA (`cpu: 2%/70%`); Prometheus
had nothing to do with it. (Grafana can *also* show CPU, through Prometheus's own
kubelet scrape, in the built-in "Kubernetes / Compute Resources" dashboards.)

### 9.8 What setting it up taught (real problems we hit)

| Problem | Lesson |
| --- | --- |
| The ticket named a Fastify Prometheus plugin, and the OTel Fastify instrumentation turned out to be deprecated (moved to `@fastify/otel`) | Check `npm view <pkg> deprecated` before adopting. Keep the ticket's goal, choose the how, and record why (ADR-0009) |
| `NodeSDK` exports **traces** over OTLP to `localhost:4318` by default | Defaults assume a Collector exists. We set `OTEL_TRACES_EXPORTER=none`, otherwise every request logs a failed export |
| A first draft added a `SIGTERM` handler to flush the SDK | Any SIGTERM listener disables Node's default exit, so Pods would hang 30 s until SIGKILL. A pull exporter has nothing to flush |
| After deploying, a mystery series appeared: status 200, **no route** | The exporter's own `/metrics` server is a Node `http` server, so the instrumentation counted Prometheus's scrapes. Found by looking at real data, then pinned with a failing test, then fixed by ignoring the metrics port |
| The metric is `http_server_request_duration`, with no `_seconds` suffix | The unit is in the `# UNIT` line. Read the real `/metrics` output before writing queries |
| A new ServiceMonitor didn't show up in Targets for ~1 min | The Operator regenerates config, then Prometheus reloads. Check the generated config before assuming the selector is wrong |
| `cms.local` resolves to Traefik's LoadBalancer IP (`10.109.105.150`), not `127.0.0.1` as the k8s runbook assumed | Ask the cluster (`kubectl get ingress` → ADDRESS) instead of trusting a hardcoded IP |
| HPA still `<unknown>` right after enabling metrics-server | New Pods' CPU is ignored for a few minutes. Read `kubectl describe hpa` conditions before changing anything |
| After a reinstall, 10 fresh 404s showed an error rate of **0** | A series is created on its first observation, so Prometheus's first sample of it was already `10`. `rate()` only sees increases *between* samples, so the jump from "no series" to 10 is invisible. The next 404s registered at once. In production you'd pre-initialise counters to 0 for known label values, or alert on `increase()` over longer windows |

---

## 10. A second bounded context: Events (roadmap stage 8)

Until now, everything about DDD was learned in one service. A bounded context only
really shows what it's for once there's a second one, with a boundary that code isn't
allowed to cross. The companion doc [`events-service-ddd.md`](events-service-ddd.md)
has the diagrams; this section is the summary.

### 10.1 The concept

A **bounded context** is a part of the system with its own model, its own language and
its own data. In Members, a person is a `Member` with a name and an email. In Events, a
person is just the `memberId` on an `Attendance`. Events never needs a name to record a
check-in, so it doesn't keep one.

Inside a context, the new idea is **several aggregates**. Members had one aggregate
(`Member`). Events has three: `ServiceEvent`, `Attendance` and `VolunteerAssignment`.
An aggregate is a **consistency boundary**: everything inside one is loaded, checked
and saved together. So the question for every rule becomes *which aggregate owns it*,
and for rules no single aggregate can check, *how are they kept anyway*.

Vocabulary:

- **Aggregate root**: the only entry point to an aggregate. Outside code calls its
  methods; it never edits its fields directly.
- **Value object**: no id, defined by its values, immutable (`Venue`).
- **Reference by id**: one aggregate points to another (`Attendance.eventId`) or to
  another context (`memberId`) by id, never by holding the object.
- **Domain event**: a past-tense fact (`AttendanceRecorded`), the future contract
  between contexts.

### 10.2 How we did it here

- **Three aggregates**, one file each, in
  [`apps/events-service/src/domain/`](../apps/events-service/src/domain/). `Attendance`
  is separate from `ServiceEvent` because a service with 500 attendees would otherwise be
  one huge aggregate that every check-in has to lock (ADR-0004's decision log).
- **A rule that needs another aggregate**: `Attendance.record()` takes the event and asks
  [`event.isOpenForCheckIn()`](../apps/events-service/src/domain/ServiceEvent.ts#L239)
  ([`Attendance.ts:65`](../apps/events-service/src/domain/Attendance.ts#L65)).
- **Uniqueness across aggregates** ("one check-in per member per event"): the use case
  checks first for a friendly 409
  ([`RecordAttendanceUseCase.ts:29`](../apps/events-service/src/application/RecordAttendanceUseCase.ts#L29)),
  and a unique index ([`schema.prisma:62`](../apps/events-service/prisma/schema.prisma#L62))
  settles races. Its error is mapped to the same 409
  ([`uniqueViolation.ts:8`](../apps/events-service/src/infrastructure/uniqueViolation.ts#L8)).
- **A use case touching many aggregates**: cancelling declines every volunteer, then
  saves the event *last*, so a failure part-way can simply be retried
  ([`CancelEventUseCase.ts:14`](../apps/events-service/src/application/CancelEventUseCase.ts#L14)).
- **A value object**: [`Venue`](../apps/events-service/src/domain/ServiceEvent.ts#L27),
  stored as three flat columns ([`schema.prisma:29`](../apps/events-service/prisma/schema.prisma#L29)).
- **Time as a parameter**: domain methods take `now`, so tests pin the clock
  ([`ServiceEvent.ts:152`](../apps/events-service/src/domain/ServiceEvent.ts#L152)).
- **Its own database**: a second Postgres, both in Kubernetes
  ([`k8s/events-postgres.yaml`](../k8s/events-postgres.yaml)) and in Compose (`events-db`
  on host port 5433, [`docker-compose.yml`](../docker-compose.yml)). `memberId` columns
  have no foreign key, because the `Member` table is on another server.
- **Everything else is a copy of members-service, on purpose**: the
  [Dockerfile](../apps/events-service/Dockerfile), the [Helm chart](../charts/events-service/values.yaml)
  (port 3002, metrics 9465, Ingress `/api/events`), the OTel setup, the CI steps and a
  `deploy.yml` paths-filter entry. Because the shape is the same, the Deploy workflow,
  `scripts/cluster-up.sh` and the Grafana RED dashboard all handle the new service
  without special cases. The dashboard's "Service" dropdown lists `events-service` on its own.

### 10.3 Why this way

- **ADR-0004** fixed the model before any code: three aggregates, `Venue`, and
  `EventType = service | event` (one aggregate for both until their rules diverge).
- **ADR-0008**: one database per service. Sharing one Postgres would have been less
  YAML, but then nothing would stop a query joining `Attendance` to `Member`, and the
  boundary would exist only on paper.
- **ADR-0007**: sync HTTP now, NATS at stage 9. So the domain events exist as types and
  return values, but nothing publishes them yet.
- **Deliberately deferred**: publishing events (CMS-22), the `@cms/events` shared
  package (created when there's a consumer), checking that a `memberId` exists
  (a sync call to Members on every check-in would make Events fail whenever Members
  does), auth (`createdById` comes in the body for now), and the endpoints for
  start/complete, confirm/decline and QR check-in. The full list is in
  [`events-service-ddd.md` §8](events-service-ddd.md#8-known-gaps-deliberate).

### 10.4 What setting it up taught (real problems we hit)

| Problem | Lesson |
| --- | --- |
| After `prisma generate` for events-service, **members-service** stopped typechecking: `Property 'member' does not exist on type 'PrismaClient'` | pnpm keeps **one** copy of `@prisma/client` for the whole monorepo, and Prisma generates into that shared folder by default. The second service's generate overwrote the first's. Fix: a per-service `output` ([`schema.prisma:10`](../apps/events-service/prisma/schema.prisma#L10)), so each client lives in its own `generated/` folder (copied into the image by its Dockerfile) |
| The ticket listed four event types, a `Location` object and separate date/time fields; ADR-0004 says otherwise | The ticket was written before the ADR was accepted. The accepted ADR wins, and the differences are recorded ([`events-service-ddd.md` §7](events-service-ddd.md#7-where-the-ticket-and-the-adr-disagreed)) so nobody "fixes" the code back to the ticket |
| The ticket's acceptance criteria asked for `EventCreated` "published to message bus" | That's stage 9 (CMS-22). Doing it now would mean building NATS inside the wrong ticket. The aggregates return the event so CMS-22 only has to publish it |
| The copied metrics test failed: it still expected `/members/:id` | `sed` replaced `/members/` but not the regex-escaped `\/members\/`. A copied test that fails at first is good news: it proves the test really checks something |
| No `minikube tunnel` (needs sudo), so `cms.local` didn't answer | `kubectl -n traefik port-forward svc/traefik 18080:80` plus `curl -H 'Host: cms.local'` goes through the real Ingress rules without root ([`k8s-local-dev.md` §7b](k8s-local-dev.md#7b-deploy-events-service)) |
| `curl http://…/members?limit=1` failed in zsh with `no matches found` | zsh treats `?` as a glob. Quote URLs that contain `?` or `&` |

---

## 11. Using AI tools (learning goal #5)

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

### 11.1 How the agent is configured (`.claude/`)

An AI agent only follows the conventions it can see. Claude Code gives you five ways to
make it see them. Each one has a different trigger and a different cost:

| Mechanism | Where | When it loads or runs | Use it for |
| --- | --- | --- | --- |
| **CLAUDE.md** | repo root | Every session, always in context | What *every* task needs: purpose, commands, workflow, indexes. Keep it short, because every line costs attention |
| **Rules** | `.claude/rules/*.md` | Only when the agent touches a matching path (`paths:` frontmatter) | Area conventions: `ddd.md` for service code, `k8s-helm.md` for charts, `testing.md`, `docs-learning.md` |
| **Skills** | `.claude/skills/<name>/SKILL.md` | When you type `/name` (or the agent decides it's relevant) | Repeatable procedures: `/start-ticket`, `/verify`, `/new-service` |
| **Hooks** | `.claude/settings.json` → `.claude/hooks/` | Automatically on events (e.g. after every Edit) | Things that must *always* happen, enforced by the harness rather than the model. `lint-file.sh` lints each edited `.ts` file |
| **Memory** | `~/.claude/projects/.../memory/` | Index loaded each session | Facts about you and the project that aren't in the repo: preferences, reminders |

Two design points are worth remembering:

- **Enforce mechanically where you can.** "Never import another context's code" used to
  be a sentence in CLAUDE.md. Now it's an ESLint `no-restricted-imports` rule in
  [`eslint.config.mjs`](../eslint.config.mjs). The lint hook catches a violation the
  moment it's written, and CI blocks the PR. Prose rules depend on the model's
  attention; lint rules don't.
- **A hook talks back only through stderr plus exit code 2.** The old hook ran
  `pnpm lint` on the whole repo after every edit, but it printed to stdout, which the
  agent never sees. It cost time and changed nothing.

`/loop` (run a prompt on a timer) was considered and left out on purpose:
`gh pr checks --watch` and `gh run watch` already block until CI and Deploy finish.

**The work queue:** Linear `Todo` in board order holds the next tickets, and the
`deferred` label marks tickets out of scope under ADR-0007. `/start-ticket` uses both, so
"what's next" is the same answer for you and for the agent.

---

## 12. Self-check — can you explain each of these?

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

**A second context: Events**

- [ ] Why is `Attendance` its own aggregate instead of a list inside `ServiceEvent`? (§10.1, §10.2)
- [ ] "One check-in per member per event": why isn't the use case's check enough on its own, and what closes the gap? (§10.2)
- [ ] Cancelling an event saves several aggregates without a transaction. Why is saving the event *last* safe to retry? (§10.2)
- [ ] What makes `Venue` a value object, and why does it need no table? (§10.2)
- [ ] Why do domain methods take a `now` parameter? (§10.2)
- [ ] Why does `Attendance.memberId` have no foreign key, and why doesn't Events check that the member exists? (§10.2, §10.3)
- [ ] Why did generating the events-service Prisma client break members-service, and what fixed it? (§10.4)

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
- [ ] Why couldn't the HPA scale before stage 7, and what fixed it? (§7.6, §9.7)
- [ ] Why can `scripts/cluster-up.sh` be run twice, but the old `helm install traefik` couldn't? (§7.7)
- [ ] Why must the monitoring stack be installed before members-service? (§7.7)
- [ ] How do you find minikube's real memory cap, and why is `free` inside the node misleading? (§7.7)
- [ ] Why does the script check `/etc/hosts` and the tunnel instead of fixing them? (§7.7)

**CI/CD**

- [ ] What makes a red test actually block the merge? (§8.1)
- [ ] Why does Deploy wait for CI on `main` instead of running on the push? (§8.2)
- [ ] Why tag images with the commit SHA instead of `latest`? (§8.2)
- [ ] Why can't GitHub's cloud runners deploy to minikube, and how is the self-hosted runner kept safe? (§8.3)

**Observability**

- [ ] Metrics, logs, traces: which one answers "how often", "what exactly", "where did the time go"? (§9.1)
- [ ] OTel SDK vs. instrumentation vs. exporter: which part would change to switch backends? (§9.2)
- [ ] Why must `instrumentation.js` load with `--import` before the app? (§9.2)
- [ ] Why is the label `/members/:id` and never the raw URL? What breaks otherwise? (§9.3)
- [ ] A new ServiceMonitor is ignored by Prometheus. What label do you check first? (§9.4)
- [ ] Explain `sum by (http_route) (rate(..._count[5m]))` piece by piece. (§9.5)
- [ ] Why p95 instead of the average? Why show 4xx and 5xx separately? (§9.5)
- [ ] metrics-server vs. Prometheus: which one does the HPA use? (§9.7)
- [ ] Why were Prometheus's scrapes being counted as requests, and how was that caught? (§9.8)

**AI tools**

- [ ] When would you put a convention in CLAUDE.md, in a rule, or in a skill? (§11.1)
- [ ] Why is the cross-service import ban an ESLint rule, not just a sentence in CLAUDE.md? (§11.1)
- [ ] How does a hook get feedback to the agent, and why did the old lint hook achieve nothing? (§11.1)
- [ ] How does `/start-ticket` decide which ticket is next? (§11.1)

---

## 13. Where to go next

The next stage is **NATS** (roadmap stage 9, CMS-22): the two contexts start talking.
The pieces are waiting for it. Events already returns `AttendanceRecorded` and
`EventCancelled` from its aggregates (§10.3), and Members returns `MemberArchived`.
Stage 9 publishes them, moves the shared payloads into `packages/` (`@cms/events`), and
lets each side react: Members keeps an attendance summary, and Events declines an
archived member's future volunteer slots. That's **eventual consistency**: the other
side catches up a moment later, instead of both changing in one transaction.

Observability has natural next steps that wait for a real need (ADR-0009):

- **Traces**: once Members and Events talk (stage 9, NATS), add an OTel Collector and
  Tempo, and put trace IDs in log lines. Then one request can be followed across services.
- **Alerting**: `PrometheusRule`s (e.g. 5xx ratio > 1% for 5 min) routed by Alertmanager,
  which is already installed. Then **SLOs**: "99% of requests under 100 ms", with error budgets.
- **Log aggregation**: Loki, so logs from all Pods are searchable in Grafana instead of
  one `kubectl logs` at a time.

To rebuild everything from scratch at any time: `scripts/cluster-up.sh --fresh` (§7.7).

Read, in this order, to go deeper than this guide:

1. [`members-service-ddd.md`](members-service-ddd.md) — DDD with full diagrams, then
   [`events-service-ddd.md`](events-service-ddd.md) for what a second context adds
2. [`docker-local-dev.md`](docker-local-dev.md) — the container workflow, hands-on
3. [`k8s-local-dev.md`](k8s-local-dev.md) — the Kubernetes deploy, hands-on
4. [`ci-cd.md`](ci-cd.md) — the pipeline, runner setup and debugging
5. [`observability.md`](observability.md) — metrics, dashboards and logs, hands-on
6. [`adr/0007-learning-scope-and-roadmap.md`](adr/0007-learning-scope-and-roadmap.md) — the why behind the sequencing
7. [`adr/context-map.md`](adr/context-map.md) — the strategic DDD picture
