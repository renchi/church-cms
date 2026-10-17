# Study Guide — Everything Built So Far

A single document to revise from. It walks through every concept this project has
exercised, mapped to the **five learning goals** in
[ADR-0007](adr/0007-learning-scope-and-roadmap.md):

1. **Docker & containers**
2. **Kubernetes** _(stages 5 and 7 done: cluster, Helm, observability)_
3. **System design** _(stage 9 done: async events between services)_
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
- [`messaging.md`](messaging.md) — NATS JetStream between the services: following an event, replay and idempotency exercises

Read this top to bottom once. Then, whenever a section feels thin, open the file it
points at (`file_path:line`) and read the real code — that is where the learning sticks.

---

## 0. Where we are on the roadmap

The roadmap is a 9-stage sequence. **All 9 stages are done**, so every learning goal
has now been exercised end to end. That is the scope of this guide.

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
| 9   | Wire NATS between Members ↔ Events            | ✅ done | async events / eventual consistency |

After stage 9: **CMS-26** finished the member registration workflow in the browser
(§5.1–5.4: Server Actions, Post/Redirect/Get, and a broken-in-the-cluster list page found on
the way). Next are CMS-27 (publish `MemberRegistered`) and CMS-20 (Communications).

The workflow itself was also tightened (§12.2–12.3): mechanical doc checks, a
`/ship` skill, image tags that make `/verify` test the current code, and a narrower
permission list.

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
  ([Dockerfile:49–64](../apps/members-service/Dockerfile#L49-L64)).
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

## 5. The frontend (roadmap stage 4, extended in CMS-26)

[`apps/web`](../apps/web) is a **Next.js 15** app using the **App Router** and **React 19**,
styled with **Tailwind CSS 4** (utility classes, mobile-first: the CMS targets phone
browsers). It joins the Compose stack (stage 4) and is deployed by its own Helm chart
(stage 5). CMS-26 added the first page that **changes** data: registering a member.

### 5.1 The concept: how a form reaches a backend

Coming from the backend side, the browser is just another HTTP client, one that renders
the response as a page and builds requests from HTML.

- **A form submit is an HTTP POST.** `<form method="post">` makes the browser send the
  fields in the request body, keyed by each input's `name` (no `name`, not sent).
- **Code runs in one of two places.** A **Server Component** (the default in the App
  Router) runs on the web Pod and ships no JavaScript. A **Client Component**
  (`"use client"`) is also downloaded to the browser, so it can react to clicks and show
  changing state. Only server code can reach cluster-internal addresses like
  `http://members-service-members-service:3001`. The browser can't resolve cluster DNS.
- **A Server Action** (`"use server"`) is a function that runs on the server and is
  called by a form: `<form action={fn}>`. The browser still sends a POST, to Next.js;
  Next.js runs the function. It's a public endpoint, so it trusts no input.
- **Post/Redirect/Get.** After a POST succeeds, answer with a redirect (`303`). The
  browser loads the target with a GET, so Refresh repeats a harmless GET instead of
  re-sending the POST. On *failure*, don't redirect: send the form back with the error
  and the typed values, which a redirect would lose.
- **`useActionState`** (React 19) connects a form to its action: it gives you the
  action's last return value (the error and the typed values) and an `isPending` flag
  while the POST is in flight.
- **`NEXT_PUBLIC_` env vars** are copied into the browser's JavaScript at build time.
  Anything without the prefix stays on the server, which is what you want for an
  internal URL.

### 5.2 How we did it here

```
Browser ──POST /members/new (form fields)──▶ Traefik ──▶ web Pod: registerMemberAction
                                                          │ JSON
                                                          ▼
                                             members-service POST /members
                                             201 {id} · 409 · 400
Browser ◀── 303 /members?registered=<id>  or  the form + error banner
```

- [`lib/membersApi.ts:73`](../apps/web/lib/membersApi.ts#L73): `registerMember()`, the
  only code that sends members-service a registration. It turns the form data into JSON
  and maps the answer to a result: `201 { id }` → ok, a domain `400`/`409` → the
  service's own message, Fastify's schema `400` → a plain "Some fields are missing or
  invalid" ([line 108](../apps/web/lib/membersApi.ts#L108)), anything else, including a
  body that isn't JSON → "Couldn't reach the members service"
  ([line 115](../apps/web/lib/membersApi.ts#L115)). It never throws: a throw would replace
  the form with Next's error page.
- [`app/members/new/actions.ts:1`](../apps/web/app/members/new/actions.ts#L1): the
  Server Action. It sends the values exactly as typed: trimming and "a blank phone means
  no phone" are `Member` rules ([`Member.ts:34`](../apps/members-service/src/domain/Member.ts#L34)).
  On failure it returns `{ error, values }`
  ([line 36](../apps/web/app/members/new/actions.ts#L36)); on success it calls
  `redirect()` with the new id ([line 45](../apps/web/app/members/new/actions.ts#L45)),
  outside any try/catch because `redirect()` works by throwing.
- [`app/members/new/RegisterForm.tsx:16`](../apps/web/app/members/new/RegisterForm.tsx#L16):
  the one Client Component: `useActionState`, the error banner, `defaultValue` from the
  returned values, and a button disabled while pending
  ([line 75](../apps/web/app/members/new/RegisterForm.tsx#L75)).
- [`app/members/page.tsx:21`](../apps/web/app/members/page.tsx#L21): `?registered=<id>`
  is looked up with `GET /members/:id`, and the banner shows the name members-service
  has. An unknown id, a repeated parameter (an array) or a failed lookup shows no banner.
  If the list can't load, the visitor sees a generic message; the details, including the
  internal URL, go to the server log ([line 40](../apps/web/app/members/page.tsx#L40)).
- [`charts/web/values.yaml:22`](../charts/web/values.yaml#L22): `config.membersApiUrl`
  becomes the Pod's `MEMBERS_API_URL`. Compose sets `http://members-service:3001` instead.
- Tests: [`lib/membersApi.test.ts`](../apps/web/lib/membersApi.test.ts) stubs `fetch`
  for each status; [`actions.test.ts`](../apps/web/app/members/new/actions.test.ts)
  mocks `redirect()`. Both are plain Vitest in a Node environment.

### 5.3 Why this way

| Choice | Instead of | Why |
| --- | --- | --- |
| Server Action | A route handler + client `fetch`, or the browser calling `/api/members` through the Ingress | The service URL stays inside the cluster, there's less plumbing, and the form even works with JavaScript off |
| Validation only in the `Member` aggregate; the form has HTML hints (`required`, `type="email"`) | A client-side schema (zod) | Copying the rules into the UI is the duplication DDD warns about (§3.2). The hints only save a round trip |
| One error banner with the service's message | Errors under each field | The service returns messages, not field names or codes. Mapping on message text would be brittle. Structured error codes are the upgrade path, deferred until a form needs them |
| Redirect with `?registered=<id>`, and look the name up | Putting the name in the URL, or a cookie "flash" message | Stateless. A name in the URL would let anyone craft a link whose green banner says anything ("content spoofing"); an id only ever shows a real member's name. Costs one extra `GET` |
| Unit tests on the action and the client | Component tests (jsdom) or Playwright | The logic is in those two functions; the form is markup. The real browser check is the `/verify` click-through |

Deliberately not done: auth on the action (Identity is deferred) and edit/archive pages.
CMS-26 was carved out of the deferred CMS-23 for just this flow.

### 5.4 What setting it up taught (real problems we hit)

| Problem | Lesson |
| --- | --- |
| On minikube, `/members` showed "Could not load members from http://localhost:3001: fetch failed", and had since the chart was written | Only Compose set the API URL; the web chart never did, so the app fell back to `localhost`, which inside a Pod is the Pod itself. Fix: `config.membersApiUrl` in the chart ([`values.yaml:22`](../charts/web/values.yaml#L22)) |
| `cluster-up.sh`'s smoke test passed anyway | It only checked status codes, and the error page is a `200`. The smoke test now also checks the page's *content* ([`cluster-up.sh:377`](../scripts/cluster-up.sh#L377)). Code review then caught that the first version only looked for the error text, so an empty body or a `502` passed too. It now requires what a working page shows (the table or "No members yet"). A check should look for success, not just for one known failure |
| The env var was called `NEXT_PUBLIC_MEMBERS_API_URL` but only server code read it | The prefix means "copy into the browser bundle", wrong for an internal URL. Renamed to `MEMBERS_API_URL` while the chart was being touched anyway |
| `next build` would reject exporting the form's initial state from `actions.ts` | A `"use server"` file may only export async functions: each export becomes a callable endpoint. Shared types and constants live in [`formState.ts`](../apps/web/app/members/new/formState.ts) |
| A real submit redirected to `?registered=undefined`, though all unit tests passed | members-service answers `201 { id }`, not the whole member. The tests' fake response was a full `Member`, so they encoded the wrong assumption. Fakes must be copied from the real API (`curl` it first), and only an end-to-end check catches the rest |
| Fastify's own `400`s say `{ error: "Bad Request", message: "body/email must NOT have fewer than 1 characters" }`; domain errors say `{ error: "Invalid email format" }` | Two error shapes from one service. The first version showed Fastify's `message`, which is written for developers. Code review: schema errors (`code: "FST_ERR_VALIDATION"`) now get a plain message; domain messages are shown as-is |
| Code review: the action trimmed the name and dropped a blank phone before sending | Both quietly duplicated `Member` rules, and one hid a rule: a name of `"   "` became `""`, failed Fastify's `minLength` and never reached "Name is required". And "blank phone means no phone" only held for the web form: any other client could store `""`. Fix: the action sends values as typed, and `Member` maps a blank phone to `null` (test first, [`Member.ts:34`](../apps/members-service/src/domain/Member.ts#L34)). A rule belongs where every caller gets it |
| Code review: the error box showed `http://members-service-members-service:3001` to every visitor | The internal address we kept out of the browser bundle still reached the browser as page text. Now the visitor gets "Could not load members. Try again in a moment.", and the details go to `kubectl logs deploy/web-web` |
| Code review: a parse error on an odd `201` body would throw out of the Server Action | Anything thrown there replaces the form with Next's error page. The client reads every body with `.catch()` and checks the `201` has an `id` |
| The smoke test failed now and then with `/` → `000` or `502` right after a web deploy | Not this feature: web runs one replica, and after `helm --wait` the old Pod stops while Traefik still routes to it. Visitors would hit it too. The fix (a `preStop` sleep or two replicas) is a separate follow-up |
| The runbook first said DevTools would show "a POST answered 303 with `Location`, then a GET" | That's only true with JavaScript off. With it on, Next.js answers the action's `fetch` with `303` plus `x-action-redirect`, and streams the new page in the same response (read in `next/dist/server/app-render/action-handler.js`). Check a framework's real behaviour before writing "expected output" |
| In the break-it exercise, `helm upgrade --reuse-values` refused to restore `MEMBERS_API_URL` after a `kubectl set env` | Helm 4 applies manifests with **server-side apply**: each field has an owner, and `kubectl set env` became the owner of that value. Helm reports the conflict instead of overwriting it; `--force-conflicts` takes ownership back ([`k8s-local-dev.md`](k8s-local-dev.md#exercise-register-a-member-through-the-ui)) |
| Submitting the form with `curl` worked, with no JavaScript | Next.js renders hidden `$ACTION_…` fields into the form, so a plain multipart POST reaches the Server Action. That's what "progressive enhancement" means, and it makes the action testable from a shell |

---

## 6. System design (learning goal #3)

Even at two services, several distributed-systems ideas are already in play:

- **Service boundaries** — Members (core) and Events (stage 8, §10) are separate
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
- ~~**A ConfigMap change doesn't restart the Pods.**~~ Fixed in stage 9: a
  `checksum/config` annotation on the Pod template (§11.2), so new config means new Pods.
- ~~**A rebuilt `:local` image doesn't restart the Pods either.**~~ Fixed after stage 9:
  `scripts/cluster-up.sh` now tags local builds `local-<sha>` (plus `-dirty-<hash>` for
  uncommitted edits), so new code means a new Pod spec and Helm rolls the Pods. It's the
  same idea CI uses with `:<sha>`. Why this mattered for the agent workflow: §12.2.

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
3. After a successful upgrade, `scripts/prune-deploy-images.sh` removes that service's
   old images on the host and inside minikube. It keeps the two tags `helm history` says
   were deployed most recently (now, and what a `helm rollback` would need); failed
   revisions don't count. A final `cleanup` job clears old build cache once per deploy.

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
| After the CMS-26 deploy the runner's disk was at **99%** (0.9 GB free), and the documented `docker builder prune` had freed **0 B** a few hours before | Two things fill a CI machine: build cache *and* the images themselves. Every deploy added a ~1.3 GB `<sha>` image per service, twice (built on the host, pulled into minikube), and nothing removed them. Deploy now prunes them itself, keeping the rollback target. Lesson: when you make artefacts unique per commit (good for traceability), you also own deleting them. Never reach for `docker image prune -a` here: minikube's own container runs on an untagged image |
| Code review of that cleanup: the first version picked "the previous image" by creation date | Dates don't say what was *deployed*: a cache-hit rebuild keeps an old date, and an image from a failed, rolled-back deploy is newer than the real rollback target. The record of what ran is `helm history`, so the script reads that. Ask "which system already knows this?" before inferring it |

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
| **Traces** | *Where did the time go* as one request crosses services | members → events → NATS | ⏳ with NATS (stage 9), once requests cross services |

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

Four more terms come up as soon as a rule spans several aggregates, because each
aggregate is saved on its own, without one transaction around all of them:

- **Race condition**: two requests interleave so that both pass a check before either
  writes. Example: two check-ins for the same member both see "not checked in yet".
- **Idempotent**: doing it twice has the same effect as doing it once. Cancelling an
  already-cancelled event is a harmless no-op, so a failed cancel can just be retried.
- **Optimistic locking**: don't lock anything while working; at the moment of saving,
  check that nobody else saved since you loaded (a `version` number), and fail with a
  conflict if they did.
- **Eventual consistency**: a rule that isn't true at every instant, but becomes true
  shortly after. Today that happens inside one use case (cancel, then decline the
  volunteers); at stage 9 it happens across services through NATS events.

### 10.2 How we did it here

- **Three aggregates**, one file each, in
  [`apps/events-service/src/domain/`](../apps/events-service/src/domain/). `Attendance`
  is separate from `ServiceEvent` because a service with 500 attendees would otherwise be
  one huge aggregate that every check-in has to lock (ADR-0004's decision log).
- **A rule that needs another aggregate**: `Attendance.record()` takes the event and asks
  [`event.isOpenForCheckIn()`](../apps/events-service/src/domain/ServiceEvent.ts#L256)
  ([`Attendance.ts:65`](../apps/events-service/src/domain/Attendance.ts#L65)).
- **Uniqueness across aggregates** ("one check-in per member per event"): the use case
  checks first for a friendly 409
  ([`RecordAttendanceUseCase.ts:29`](../apps/events-service/src/application/RecordAttendanceUseCase.ts#L29)),
  and a unique index ([`schema.prisma:65`](../apps/events-service/prisma/schema.prisma#L65))
  settles races. Its error is mapped to the same 409
  ([`uniqueViolation.ts:8`](../apps/events-service/src/infrastructure/uniqueViolation.ts#L8)).
- **A use case touching many aggregates**: cancelling saves the event, then declines
  every volunteer. It's idempotent, so a failure part-way is fixed by cancelling again,
  and a volunteer assigned at the same moment re-checks the event and declines itself
  ([`CancelEventUseCase.ts`](../apps/events-service/src/application/CancelEventUseCase.ts),
  [`events-service-ddd.md` §3.3](events-service-ddd.md#33-cancelling-declines-all-volunteers-several-saves-no-transaction)).
- **Optimistic locking**: a `version` column, and saves that only apply if nobody else
  saved in between; otherwise `409`
  ([`events-service-ddd.md` §3.4](events-service-ddd.md#34-two-edits-at-once-optimistic-locking)).
- **A value object**: [`Venue`](../apps/events-service/src/domain/ServiceEvent.ts#L27),
  stored as three flat columns ([`schema.prisma:29`](../apps/events-service/prisma/schema.prisma#L29)).
- **Time as a parameter**: domain methods take `now`, so tests pin the clock
  ([`ServiceEvent.ts:170`](../apps/events-service/src/domain/ServiceEvent.ts#L170)).
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
| Code review: an edit made on a stale copy could save `status: scheduled` over a cancellation | "Load, change, save everything" loses updates when two requests overlap. A `version` column turns the silent overwrite into a `409` (optimistic locking). The column came as a **second** migration: `init` was already applied in the cluster, and Prisma rejects an applied migration whose checksum changed |
| Code review: cancelling saved the event *last*, so a volunteer assigned during the cancel stayed `pending` | Rules across aggregates without a transaction need an argument that **every** interleaving is covered. Saving the event first, plus a re-check on the assign side, closes it. Cancel became idempotent so it stays retryable |
| After adding the `version` column, editing an event created **before** the migration returned `500` (`Unique constraint failed on the fields: (id)`) | The repository uses version `0` to mean "never saved, INSERT it", and the migration gave existing rows `DEFAULT 0`. So old rows were inserted again. Fix: `DEFAULT 1`, plus a test that inserts a row the way the *previous* release would. Lesson: a migration must be checked against the data that already exists, not just against a fresh database (which is all the integration tests use) |
| Running the "stop the database" exercise, the 500 body contained Prisma's message and the DB hostname | Default error handlers leak internals. Recorded as a gap for both services rather than fixed in one |

---

## 11. Async messaging with NATS (roadmap stage 9)

Stage 8 gave us two bounded contexts that know nothing about each other. But each one
needs to *react* to things that happen in the other: Events must stop counting on a
member who was archived, and Members wants to show how often someone attends. This
stage connects them **without** connecting their code or their databases. The
runbook is [`messaging.md`](messaging.md); the decision record is
[ADR-0010](adr/0010-async-messaging-nats.md).

### 11.1 The concept

**Sync vs. async.** With sync HTTP, Members would *call* Events ("decline this
member's volunteer slots") and wait for the answer. If Events is down, archiving fails
too, and Members has to know who cares about archives. With **publish/subscribe**,
Members announces a fact ("member X was archived") to a **message broker** and moves
on. Whoever subscribed reacts in their own time. Members doesn't know or care who
listens. A third subscriber later (Finance, Groups) needs no change in Members.

**NATS** is the broker: one small server. Messages are published to a **subject**,
a dot-separated name like `cms.members.archived`. Subscribers can use wildcards
(`cms.members.>` = everything under `cms.members`).

**Core NATS vs. JetStream.** Core NATS is fire-and-forget: a message with no
listener at that moment is gone. **JetStream** adds persistence:

- A **stream** stores every message on its subjects, on disk (`MEMBERS` stores `cms.members.>`).
- A **durable consumer** is a named reader of a stream. The server remembers, by name,
  which messages it has acknowledged. If the service stops and restarts, it picks up
  where it left off and receives everything it missed: **replay**.
- Each message must be answered: **ack** (done), **nak** (failed, redeliver later) or
  **term** (can never succeed, stop trying). An unanswered message is redelivered after
  a timeout.

That redelivery is what makes it reliable, and it creates the two classic problems of
messaging:

1. **At-least-once delivery → idempotency.** If the consumer does its work but crashes
   before acking, the message comes again. So handling a message twice must have the
   same effect as handling it once. Otherwise one check-in is counted twice.
2. **The dual-write problem → the transactional outbox.** A use case must change its
   database *and* publish a message. Those are two systems, so no single transaction
   covers both. Crash between them and you've either announced something that wasn't
   saved, or saved something nobody hears about. The fix: write the message into an
   **outbox table** in the *same* database transaction as the change. A separate
   **relay** loop then publishes outbox rows and marks them done.

**Eventual consistency.** After a check-in, Members' attendance count is out of date
for a moment, until the message arrives. The system is consistent *eventually*, not at
every instant. That's the price of not making Events wait for Members.

**The wire contract.** What travels between contexts is a published contract, versioned
and validated, separate from either context's internal model. It's the anti-corruption
layer from §10, applied to messages.

### 11.2 How we did it here

Two flows, one in each direction:

| Event                | From → To         | Subject                          | Effect                                                         |
| -------------------- | ----------------- | -------------------------------- | -------------------------------------------------------------- |
| `MemberArchived`     | Members → Events  | `cms.members.archived`           | Volunteer assignments on future, scheduled events → `declined` |
| `AttendanceRecorded` | Events → Members  | `cms.events.attendance.recorded` | `Member.attendanceCount` +1, `lastAttendedAt` moves forward    |

**The shared package `@cms/events`** ([`packages/events/src`](../packages/events/src)),
the only code both services may import:

- The contract: subject and stream names
  ([`contract.ts:14`](../packages/events/src/contract.ts#L14)), a common **envelope**
  `{ id, type, version, occurredAt, data }`
  ([`contract.ts:38`](../packages/events/src/contract.ts#L38)), and `parse*` functions
  that validate incoming JSON
  ([`contract.ts:105`](../packages/events/src/contract.ts#L105)).
- Idempotent setup: `ensureStream` and `ensureConsumer`, "create, or update to this
  config" ([`nats.ts:51`](../packages/events/src/nats.ts#L51),
  [`nats.ts:78`](../packages/events/src/nats.ts#L78)).
- The outbox relay ([`outboxRelay.ts:66`](../packages/events/src/outboxRelay.ts#L66)) and
  the ack/nak/term decision for each message
  ([`consumer.ts:37`](../packages/events/src/consumer.ts#L37)). Neither knows about
  Prisma: each service passes in functions over its own tables.

**Publishing (the outbox), using archive as the example:**

1. `ArchiveMemberUseCase` takes the event that `member.archive()` returns and passes it
   to `repo.save(member, [event])`
   ([`ArchiveMemberUseCase.ts:10`](../apps/members-service/src/application/ArchiveMemberUseCase.ts#L10)).
   The use case never talks to NATS.
2. The repository maps the domain event to the wire format
   ([`outbox.ts:21`](../apps/members-service/src/infrastructure/outbox.ts#L21)) and writes
   the member row and an `OutboxMessage` row in **one** transaction
   ([`PrismaMemberRepository.ts:79`](../apps/members-service/src/infrastructure/PrismaMemberRepository.ts#L79)).
3. The relay, about once a second, publishes unpublished rows in order, with the row id
   as the `Nats-Msg-Id` header ([`nats.ts:116`](../packages/events/src/nats.ts#L116)), and
   sets `publishedAt`. If publishing fails, it stops the batch and retries next tick, so
   order is kept. Both Pods run a relay, but each batch first takes a Postgres advisory
   lock ([`outbox.ts`](../apps/members-service/src/infrastructure/outbox.ts)), so only one
   of them publishes at a time.
   If it crashes after publishing but before marking, it publishes again and JetStream
   drops the duplicate id within the stream's 2-minute `duplicate_window`.

Events does the same for check-ins
([`PrismaAttendanceRepository.ts:25`](../apps/events-service/src/infrastructure/PrismaAttendanceRepository.ts#L25)).
A rejected duplicate check-in rolls back the outbox row together with the attendance.

**Consuming (idempotently), using archive as the example:**

1. events-service has a durable consumer named `events-service` on the `MEMBERS` stream,
   filtered to `cms.members.archived`.
2. Each message is parsed (bad JSON or a wrong version → `term`), then handed to
   `DeclineAssignmentsForArchivedMemberUseCase`
   ([`DeclineAssignmentsForArchivedMemberUseCase.ts:21`](../apps/events-service/src/application/DeclineAssignmentsForArchivedMemberUseCase.ts#L21)).
3. The use case runs inside `UnitOfWork.runOnce(messageId, work)`. The Prisma version
   opens a transaction, inserts the message id into `ProcessedMessage` with
   `ON CONFLICT DO NOTHING` (`skipDuplicates`,
   [`PrismaUnitOfWork.ts:16`](../apps/events-service/src/infrastructure/PrismaUnitOfWork.ts#L16)),
   and runs `work` only if a row was actually inserted. The processed id and the
   declined assignments commit together, so a redelivery finds the id and does nothing.
4. Success → `ack`. A database error → `nak` with a growing delay (1 s, 2 s, 4 s … 30 s),
   retried with no limit ([`consumer.ts`](../packages/events/src/consumer.ts)). A limit
   would quietly drop good messages during a long database outage.

**Concurrent writers.** Two consumer Pods, or the consumer and an HTTP archive, can
load the same `Member` at once. If both saved their whole copy, the second would
undo the first's change: a lost attendance, or even an archive reverted. `Member` has
a `version` column, as `ServiceEvent` does (§10.2): a save only applies if the version
is still the one loaded, otherwise `ConflictError`. HTTP answers `409`; the consumer
rolls back and `nak`s, and the redelivery works on fresh data.

Members' side is the same shape, with `Member.recordAttendance()`
([`Member.ts:124`](../apps/members-service/src/domain/Member.ts#L124)): it counts the
attendance and only moves `lastAttendedAt` *forward*, because messages can arrive out of order.

**Startup and shutdown.** Messaging starts *after* the HTTP server, in the background
([`index.ts:34`](../apps/members-service/src/index.ts#L34)). While NATS is down, HTTP
works and events wait in the outbox. Each service declares **both** streams from the
shared config ([`messaging.ts:49`](../apps/members-service/src/infrastructure/messaging.ts#L49)),
so either can start first. On SIGTERM, the consumer stops, the relay finishes its batch,
and the connection drains.

**Infrastructure:** NATS from the official Helm chart in its own `nats` namespace
([`k8s/nats-values.yaml`](../k8s/nats-values.yaml)): one server, JetStream on a 1 Gi
PVC, plus `nats-box` for inspecting it. Compose gets a `nats` service. Both charts pass
`NATS_URL` through their ConfigMap, and a `checksum/config` annotation
([`deployment.yaml:20`](../charts/members-service/templates/deployment.yaml#L20)) makes a
ConfigMap change roll the Pods.

### 11.3 Why this way

- **NATS over Kafka (ADR-0010):** same ideas (streams, consumers, replay) for a fraction
  of the moving parts. One small server fits next to Prometheus in a 6 GB minikube.
- **Outbox over "publish after save":** "publish after save" is simpler and *usually*
  works. The outbox is the version that is still correct when a Pod is killed at the
  worst moment. Learning that difference is the point of this stage.
- **Idempotency by a processed-ids table, not by "naturally idempotent" handlers:**
  declining is naturally idempotent, but counting attendance is not. One mechanism for
  both is easier to reason about than two.
- **A shared package for the contract, but separate domain types:** each context keeps
  its own `domain/events.ts`. Only the wire shape is shared, so neither domain can leak
  into the other.
- **The ticket was re-scoped.** CMS-22 originally wired subscribers into Communications
  and Groups. Both are deferred (ADR-0007), so the ticket now covers the two live services.
- **One relay at a time, by an advisory lock.** Each service runs 2 Pods, and each Pod
  runs a relay. Each batch first takes a Postgres advisory lock, a lock on a number we
  choose rather than on a row. Only the Pod holding it publishes, so no row goes out
  twice and the order holds. Simpler than `FOR UPDATE SKIP LOCKED`, which shares rows
  between relays but gives up global order.
- **Deliberately deferred** (ADR-0010's evolution table): relays sharing the work
  (`FOR UPDATE SKIP LOCKED`), pruning `ProcessedMessage`, `V2` events, tracing
  across the bus (OTel context in message headers), and a 3-node NATS cluster.

### 11.4 What setting it up taught (real problems we hit)

| Problem | Lesson |
| --- | --- |
| The ticket asked for subscribers in Communications and Groups | Both services are deferred (ADR-0007). The ticket was re-scoped in Linear to the two live services before any code. Check a ticket against the ADRs *first*; it may predate them |
| `AttendanceRecorded`'s payload has an `eventId` (the church event). Using `eventId` as the dedupe key too would have collided | Separate the **envelope** (`id`, `type`, `version`, `occurredAt`) from the **data**. The message's identity and the business fields never share a name |
| A table called `OutboxEvent` in events-service, where "event" already means a church service | Names matter most where two languages meet. Both services call them `OutboxMessage` and `ProcessedMessage` |
| `StreamNotFoundError` exists in `@nats-io/jetstream` but isn't exported from its public API | Don't reach into a library's internal paths. Check the public `JetStreamApiError.code` against `JetStreamApiCodes.StreamNotFound` instead ([`nats.ts`](../packages/events/src/nats.ts)) |
| The consumer's "already processed?" check and its change must commit together, but each repository method ran on its own | A `UnitOfWork` port in the application layer: `runOnce` opens the transaction and hands the use case repositories bound to it. `inTransaction` lets a repository's `save` join an open transaction instead of opening its own |
| CI typechecks and tests **before** building, so `@cms/events`' `dist/` didn't exist yet | A `prepare` script: pnpm runs it for workspace packages during `pnpm install`, so `dist/` exists right after install, in CI, locally and in Docker |
| `prepare` runs during the Docker `pnpm install` too, so a Dockerfile that only copied the package's `package.json` would fail (`tsc` with no sources), even web's | Copy the whole (small) `packages/events` before the install in **all three** Dockerfiles. The service images also copy it into the runtime stage, because `node_modules/@cms/events` is a symlink into it |
| Adding `NATS_URL` to the ConfigMap wouldn't have reached running Pods | Kubernetes only rolls Pods when the Pod **template** changes. A `checksum/config` annotation (the ConfigMap's hash) puts the config into the template. On the first deploy, the members Pods rolled by themselves |
| Chart `nats` 2.15.1 had been released two days earlier | Pin a version that has been out for a while (2.15.0, three weeks), and run the same server version in Compose and the tests |
| `nats-0` showed `FailedScheduling: unbound immediate PersistentVolumeClaims` on the first install | The volume didn't exist yet; minikube's provisioner created it a few seconds later. Read an event's *age and count* before treating it as a failure |
| The ADR first said "more than one replica" was a *future* trigger for a smarter relay, but the charts already run 2 | Verifying in the real cluster caught that both Pods run a relay. At first I documented it as "harmless, thanks to dedupe", but the code review pointed out that the comments still promised ordering. The fix was small: a Postgres advisory lock per batch, so one relay publishes at a time |
| Code review: two consumer Pods could each take a different attendance message for the same member, both read `count = 5`, and both write `6` | Moving work into background consumers creates **concurrent writers** that HTTP alone never had. The same lost update could even revert an archive. Optimistic locking (`Member.version`) turns it into a conflict; the consumer `nak`s and the retry reads fresh data |
| The `version` column couldn't go into the messaging migration: that migration was already applied in the cluster | Once a migration has run anywhere, it's frozen. Prisma rejects a changed checksum, so the column is a second migration. Same lesson as §10.4 |
| Code review: `max_deliver: 10` with a 1–30 s backoff gives up after ~2.5 minutes | A redelivery limit turns a long database outage into **silently lost messages**. Transient failures retry with no limit; only messages that can never succeed are `term`ed |
| Code review: if the consumer loop died, the Pod stayed Ready but processed nothing | The loop is now supervised, and the service exits on failure so Kubernetes restarts it. Testing that took two tries: deleting a consumer is noticed **instantly** if a pull request is open, but only at the next heartbeat check (~30 s) if not. A test with a 15 s timeout failed once in five runs; the budget now covers both paths |
| `nats stream info` on a missing stream doesn't say "not found"; it tries to prompt for a stream name | Runbook text should come from running the command, not from memory. The troubleshooting table uses the message actually seen |

---

## 12. Using AI tools (learning goal #5)

The development method itself is a learning goal: **issue-driven development with Claude
Code + Linear**. Each chunk of work maps to a Linear ticket (CMS-5, CMS-6, CMS-12 …, visible
in the roadmap table and git history). The workflow:

1. A ticket defines a small, reviewable slice of work.
2. Claude Code implements it against the existing code and conventions.
3. Decisions that shape architecture are written down as **ADRs**, not left in chat.
4. Code is heavily commented **for learning**, not just for shipping.
5. Every ticket goes through the same **quality loop**: plan → implement → verify in the
   running app → `/code-review` (fix every finding) → `/ship` (PR → CI green → merge). On CMS-16,
   the review caught two real bugs: deploy didn't wait for CI, and typecheck ignored the
   Prisma types.

The takeaway as a modern developer: AI tools are most effective when scoped by clear
tickets, anchored by written decisions (ADRs), and verified by tests — exactly the loop
this repo models.

### 12.1 How the agent is configured (`.claude/`)

An AI agent only follows the conventions it can see. Claude Code gives you five ways to
make it see them. Each one has a different trigger and a different cost:

| Mechanism | Where | When it loads or runs | Use it for |
| --- | --- | --- | --- |
| **CLAUDE.md** | repo root | Every session, always in context | What *every* task needs: purpose, commands, workflow, indexes. Keep it short, because every line costs attention |
| **Rules** | `.claude/rules/*.md` | Only when the agent touches a matching path (`paths:` frontmatter) | Area conventions: `ddd.md` for service code, `k8s-helm.md` for charts, `testing.md`, `docs-learning.md` |
| **Skills** | `.claude/skills/<name>/SKILL.md` | When you type `/name` (or the agent decides it's relevant) | Repeatable procedures: `/start-ticket`, `/verify`, `/ship`, `/new-service` |
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

### 12.2 Closing the loop: verify, review, ship

**The concept.** An agent writes code fast, so the bottleneck moves to *checking* it. A
workflow is only as good as its gates: the points where work has to prove itself before it
moves on. A gate that depends on someone remembering to look carefully will sometimes be
skipped. A gate that a script or the harness runs every time won't. So, wherever a check can
be decided by a machine, make it mechanical, and save human (and model) attention for what
can't be.

Here the loop is `/start-ticket` → plan → implement → `/verify` → `/code-review` → `/ship`,
and each step has a mechanical core:

| Gate | Mechanical part | Still judgement |
| --- | --- | --- |
| Edit | `lint-file.sh` hook: ESLint on every edited `.ts` file | |
| `/verify` | tests, typecheck, `helm lint`; Pods must run **this build's image tag**; `scripts/check-docs.sh` | does the feature do what the ticket asked? |
| `/code-review` | | bugs, design, missing edge cases |
| CI | the three required checks, plus `check-docs.sh` inside `lint-typecheck` | |
| `/ship` | disk check, PR from the template, `gh pr checks --watch`, `gh run watch` | **merge: always the user** |

**How we did it here.**

- [`scripts/check-docs.sh`](../scripts/check-docs.sh) fails on a doc link to a missing file,
  a line link past the end of its file, or a label like `` `x.ts:29` `` whose anchor says
  `#L31`. It *warns* about line links into files this branch changed, because only a person
  can tell whether line 52 is still the right line. CI runs it in
  [`ci.yml`](../.github/workflows/ci.yml) (`lint-typecheck`).
- [`scripts/cluster-up.sh`](../scripts/cluster-up.sh) §4 tags images by content, and its
  smoke test checks that every Deployment runs that tag.
- [`.claude/skills/ship/SKILL.md`](../.claude/skills/ship/SKILL.md) runs the PR → CI →
  merge → Deploy → Done steps, and
  [`.github/pull_request_template.md`](../.github/pull_request_template.md) gives every PR the
  same shape (ticket, verify table, learning checklist, deploy impact). The steps by hand are
  in [`ci-cd.md`](ci-cd.md) ("Shipping a ticket with `/ship`").

**Why this way.** The git history showed the pattern: almost every large ticket had a
follow-up "address code review" commit, and CMS-18 also had "fill learning-doc gaps found in
review" and "fix code links whose line numbers moved". Review is the most expensive gate, so
anything it catches that a script could have caught is wasted attention. The trade-off:
every check adds a little friction, so only add the ones that have actually failed before.
That's why `check-docs.sh` checks links and not, say, prose style. Deliberately not done: a
subagent that reviews the learning docs before `/code-review`. Add it if doc gaps keep
reaching review after this.

**Suggested, not automatic: the design skills.** Some skills only pay off on certain tickets.
`grill-with-docs` and `domain-modeling` (from the `mattpocock-skills` plugin) stress-test a
new context's design against the ADRs, and `tdd` drives domain behaviour test-first.
`/start-ticket` suggests the ones that match the ticket, in one line with the reason, before
plan mode, and `/ship` suggests a `retro` after the merge. The agent doesn't run them itself,
because a grilling session costs your time, and a reminder that appears on every ticket
soon gets ignored. The trigger is in the skill that already knows the ticket, not in a hook
that fires on everything.

**What setting it up taught:**

| Problem | Lesson |
| --- | --- |
| `/verify` step 4 rebuilt `members-service:local` and ran `helm upgrade` with the same tag. The Pod spec didn't change, so the old Pods kept running, and "exercise the feature" could test code from before the change | A verification gate that can pass on stale code is worse than none, because it gives false confidence. Make the artifact's identity part of the check: tag by commit, then assert the running image has that tag |
| The first run of `check-docs.sh` failed on `main`: study-guide §2.2 linked to `Dockerfile#L317`, in a 179-line file. Several reviews had read past it | Reviewers check what changed, not what rotted. Only a check that looks at *everything*, every time, finds rot |
| Line links can't be checked for *correctness*, only for existence | Split it: errors for what a script can decide, warnings that name the exact link for what it can't |
| The new "is the Pod on this tag?" smoke check killed the script silently: it asked for `deploy/members-service`, but the charts name it `members-service-members-service` (`<release>-<chart>`), and `set -e` exited on the failed `kubectl` | Test a new check against the real cluster, not the name you expect. A check that can't find its target must report "not found", not take the script down with it |
| `check-docs.sh` passed locally but failed on its first CI run: `docker-local-dev.md` linked to `apps/members-service/.env`, which exists on this machine but is gitignored | A check that reads the working tree sees files nobody else has. It now rejects links to gitignored files, so the local run and CI give the same answer. Run new checks in CI before trusting a local green |
| Running `scripts/cluster-up.sh --skip-build` with Claude Code's `!` prefix still didn't start the tunnel, and printed no reason | `!` runs the command with no terminal, so sudo can't ask for a password and the script quietly stays check-only. Steps that need a human (a password, a browser login) must run in the human's own terminal, and the script now says so when it can't ask |
| Two full rebuilds while testing this took the disk from 11 GB to 4.9 GB free (92%), mostly build cache | Every rebuild leaves cache behind. The script now deletes superseded `local-*` tags. Build cache still needs a `docker builder prune -af` (host and minikube), which is why `/ship` checks the disk before pushing |

### 12.3 Least privilege for agents

**The concept.** `.claude/settings.json`'s `permissions.allow` list says which commands the
agent may run without asking you. Every entry is a trade: fewer prompts, but less of a
chance to stop a mistake. The question for each one is "what's the worst this pattern
allows?", not "what did I mean it for?".

**How we did it here.** The list was narrowed in
[`.claude/settings.json`](../.claude/settings.json):

| Was | Also allowed | Now |
| --- | --- | --- |
| `git checkout *` | `git checkout -- .`: discard every uncommitted change | `git checkout -b *`, `git checkout main` |
| `gh pr *` | `gh pr merge`, `gh pr close` | `create`, `view`, `checks`, `diff`, `list` |
| `kubectl apply *` | applying any manifest to the cluster, from anywhere | `--dry-run=server …` and `--dry-run=client …` only. Real applies go through `cluster-up.sh` |
| `kubectl exec *` | a shell in any Pod, including the databases | only `nats` commands in `nats-box` |

**Why this way.** Patterns match text, not intent. `git checkout *` was meant for switching
branches. Narrow patterns that fit the workflow keep the prompts rare *and* meaningful: when
Claude Code does ask, it's for something worth a look. The merge is the clearest case:
`/ship` asks before merging, but the permission list makes sure of it even if the skill text
were ignored. Code review caught the first attempt: `--dry-run=*` also matches `--dry-run=none`, which
is a *real* apply, and `-f k8s/*` matches `-f k8s/x.yaml -f /anywhere.yaml`. A wildcard
in an allow rule allows whatever text fits it, so spell out the safe values. This is the same idea as §12.1's "enforce mechanically where you can", applied
to the agent itself.

---

## 13. Self-check — can you explain each of these?

If you can answer these from memory, you've absorbed what's been built. If not, the section
in parentheses (and the file it links) is where to look.

**Docker**

- [ ] What does a multi-stage build save you, concretely? (§2.2)
- [ ] Why copy `package.json` before the source code? (§2.2 layer caching)
- [ ] How does `members-service` find the database — and why not `localhost`? (§2.4)
- [ ] What do the three `depends_on` conditions each wait for? (§2.4)
- [ ] Why run migrations as a separate job instead of in the app? (§2.4)

**Frontend: forms and Server Actions**

- [ ] What does the browser actually send when the registration form is submitted, and what decides the keys? (§5.1)
- [ ] Why can't the form call `http://members-service-members-service:3001` from the browser? (§5.1)
- [ ] Why redirect after a successful registration, but not after a duplicate email? (§5.1)
- [ ] Why does `redirect()` have to stay outside any try/catch in a Server Action? (§5.2)
- [ ] Why does the form show the service's message instead of validating the email itself? (§5.3)
- [ ] How did the members list stay broken on minikube without the smoke test noticing, and what changed? (§5.4)
- [ ] All unit tests passed, yet the redirect said `registered=undefined`. What was wrong with the tests? (§5.4)
- [ ] After `kubectl set env`, why does a plain `helm upgrade` refuse to put the chart's value back? (§5.4)
- [ ] Why does the redirect carry the member's id, not their name? (§5.3)
- [ ] Why does the Server Action send the name untrimmed? (§5.4)

**DDD**

- [ ] Why is `Member`'s constructor private? (§3.2)
- [ ] Where do business invariants live, and where do they _not_? (§3.2, §3.6)
- [ ] What is the repository pattern buying you? (§3.4)
- [ ] Difference between a use case and the aggregate? (§3.2 vs §3.5)
- [ ] What is the ACL rule, and what's a read model? (§3.7)

**A second context: Events**

- [ ] Why is `Attendance` its own aggregate instead of a list inside `ServiceEvent`? (§10.1, §10.2)
- [ ] "One check-in per member per event": why isn't the use case's check enough on its own, and what closes the gap? (§10.2)
- [ ] Cancelling saves several aggregates without a transaction. How do idempotency and "save the event first, re-check on assign" keep the rule true? (§10.2, §10.4)
- [ ] Two admins edit the same event at once. What does the `version` column change about the outcome? (§10.2)
- [ ] What makes `Venue` a value object, and why does it need no table? (§10.2)
- [ ] Why do domain methods take a `now` parameter? (§10.2)
- [ ] Why does `Attendance.memberId` have no foreign key, and why doesn't Events check that the member exists? (§10.2, §10.3)
- [ ] Why did generating the events-service Prisma client break members-service, and what fixed it? (§10.4)

**Async messaging (NATS)**

- [ ] Archiving a member could call Events over HTTP instead. What would that couple, and what does publishing a message decouple? (§11.1)
- [ ] What does JetStream add to core NATS, and what makes a consumer "durable"? (§11.1)
- [ ] What is the dual-write problem, and how does the outbox make "save and publish" safe even if the Pod is killed between the two? (§11.1, §11.2)
- [ ] The relay publishes a row and crashes before marking it published. What happens next, and which two mechanisms stop the duplicate doing harm? (§11.2)
- [ ] Why must the processed message id be inserted in the same transaction as the change? What breaks if it's committed on its own? (§11.2)
- [ ] When does a consumer `ack`, `nak` and `term` a message, and why does a `nak` get a growing delay? (§11.2)
- [ ] Why does `recordAttendance` only move `lastAttendedAt` forward? (§11.2)
- [ ] Why do both services declare both streams, and why doesn't that break "each publisher owns its stream"? (§11.2, ADR-0010)
- [ ] The attendance consumer and an HTTP archive load the same member at once. What goes wrong without `Member.version`, and what happens to each writer with it? (§11.2, §11.4)
- [ ] Both Pods run an outbox relay. What stops them publishing the same row twice, and why is a redelivery limit (`max_deliver`) a bad idea here? (§11.2, §11.3)

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
- [ ] SHA tags made every image unique. What did that cost, and which two images does Deploy keep per service? (§8.2, §8.4)
- [ ] Why is `docker image prune -a` dangerous on this machine? (§8.4)
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

- [ ] When would you put a convention in CLAUDE.md, in a rule, or in a skill? (§12.1)
- [ ] Why is the cross-service import ban an ESLint rule, not just a sentence in CLAUDE.md? (§12.1)
- [ ] How does a hook get feedback to the agent, and why did the old lint hook achieve nothing? (§12.1)
- [ ] How does `/start-ticket` decide which ticket is next? (§12.1)
- [ ] Why can rebuilding an image under the same tag make `/verify` pass on old code? How does a `local-<sha>` tag fix it? (§12.2, §7.6)
- [ ] Which documentation mistakes does `scripts/check-docs.sh` fail on, and which does it only warn about? Why the split? (§12.2)
- [ ] Why does the disk check come *before* the push in `/ship`, not after the merge? (§12.2, `ci-cd.md`)
- [ ] Name one gate in this workflow that's mechanical and one that's judgement. Why isn't review mechanical? (§12.2)
- [ ] What does `Bash(git checkout *)` allow besides switching branches? How would you narrow an allow rule? (§12.3)
- [ ] Why is "the skill says ask before merging" not enough on its own? (§12.3)
- [ ] Why does `/start-ticket` *suggest* `grill-with-docs` only for some tickets instead of running it on every one? (§12.2)

---

## 14. Where to go next

All nine roadmap stages are done, and the member registration workflow is now usable from
the browser (§5). The committed queue is **CMS-27** (publish `MemberRegistered` over NATS),
then **CMS-20** (Communications, the welcome email). From here, ADR-0007 suggests adding the deferred
contexts (Finance, Communications, Groups, Identity) **one at a time**, as practice.
Each one is now mostly a matter of applying patterns already learned. The most
interesting next contexts are the ones that add a new kind of message flow:

- **Communications** consuming `MemberRegistered` (a welcome email): Members would
  publish its first new event type since stage 9. It's a type in `@cms/events`, a case in
  `outbox.ts`, and nothing changes on the Events side (§11.3, ADR-0010).
- **Validating `memberId` in Events from messages**: a local list of known members,
  kept up to date from `MemberRegistered`/`MemberArchived`, instead of a sync call
  ([`events-service-ddd.md` §8](events-service-ddd.md#8-known-gaps-deliberate)).

Messaging has its own next steps, each with a trigger (ADR-0010's evolution table):
a multi-replica-safe relay, pruning `ProcessedMessage`, a `V2` event alongside `V1`,
and a 3-node NATS cluster.

Observability has natural next steps that wait for a real need (ADR-0009):

- **Traces**: Members and Events now talk through NATS, so this trigger has fired. An
  OTel Collector and Tempo, with trace context carried in message headers, would let
  you follow one archive from the HTTP request, through the outbox and NATS, to the
  declined assignments. For now, follow a message by its `id` in both services' logs.
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
6. [`messaging.md`](messaging.md) — NATS, the outbox and idempotent consumers, hands-on
7. [`adr/0007-learning-scope-and-roadmap.md`](adr/0007-learning-scope-and-roadmap.md) — the why behind the sequencing
8. [`adr/context-map.md`](adr/context-map.md) — the strategic DDD picture
