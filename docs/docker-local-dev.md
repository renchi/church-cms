# Running the stack locally with Docker

This guide covers running the Phase 1 services on your machine with Docker. It has
two parts:

1. **[The normal workflow](#the-normal-workflow-docker-compose)** — `docker compose`,
   how you actually run things day to day.
2. **[Doing it by hand](#doing-it-by-hand-raw-docker)** — the equivalent raw `docker`
   commands, so you understand what Compose is doing for you. This is a learning
   exercise, not the recommended daily workflow.

The stack is defined in [`docker-compose.yml`](../docker-compose.yml) at the repo
root. It runs four things:

| Service           | What it is                                          | Port   |
| ----------------- | --------------------------------------------------- | ------ |
| `members-db`      | PostgreSQL 16                                       | `5432` |
| `members-migrate` | One-shot job: applies the Prisma schema, then exits | —      |
| `members-service` | The Fastify + Prisma API                            | `3001` |
| `adminer`         | Web UI for browsing the database                    | `8080` |

---

## The normal workflow (`docker compose`)

### Prerequisites

- Docker (with the Compose v2 plugin — `docker compose`, not the old `docker-compose`)
- A `.env` file at the repo root. Copy the example and adjust if you like:
  ```bash
  cp .env.example .env
  ```

### Start everything

```bash
docker compose up --build
```

The first run builds the `members-service` image, then starts the stack **in
order**: `members-db` → `members-migrate` (applies the schema, exits) →
`members-service`, with `adminer` alongside. When it settles you have:

- API at <http://localhost:3001> — try `curl localhost:3001/health`
- Adminer at <http://localhost:8080>
- Postgres at `localhost:5432`

After the first build, drop `--build` for faster starts:

```bash
docker compose up          # foreground, logs stream to your terminal
docker compose up -d       # detached (background)
```

### Connect Adminer to the database

Open <http://localhost:8080> and log in with the values from your `.env`:

| Field    | Value                                  |
| -------- | -------------------------------------- |
| System   | PostgreSQL                             |
| Server   | `members-db`                           |
| Username | value of `POSTGRES_USER` in `.env`     |
| Password | value of `POSTGRES_PASSWORD` in `.env` |
| Database | value of `POSTGRES_DB` in `.env`       |

> Server is `members-db` (the service name), **not** `localhost` — see
> [why service names, not localhost](#why-service-names-not-localhost) below.

### Everyday commands

```bash
docker compose ps                       # what's running + health status
docker compose logs -f members-service  # tail one service's logs
docker compose restart members-service  # restart a single service
docker compose exec members-db psql -U cms_user -d members_db   # psql into the DB
```

### Stop / clean up

```bash
docker compose down       # stop and remove containers; DB volume SURVIVES
docker compose down -v    # also delete the volume — wipes all DB data
```

Use `down -v` when you want a truly fresh start (the next `up` re-runs migrations
against an empty database).

---

## Doing it by hand (raw `docker`)

Everything above is Compose _orchestrating_ plain Docker primitives:
`docker network`, `docker volume`, `docker build`, `docker run`. Running them
yourself is the best way to see what Compose actually does — and where its value
is. Run these from the repo root.

> **You are the orchestrator here.** Compose created the network and volume,
> waited for the database to be healthy, ran the migration job to completion, and
> only then started the service. By hand, you do that sequencing yourself.

### Load your credentials first

The commands below read credentials from `.env` rather than hardcoding them.
Export it into your shell so `$POSTGRES_USER`, `$POSTGRES_PASSWORD`, and
`$POSTGRES_DB` are available to every command that follows:

```bash
set -a; source .env; set +a   # export every variable defined in .env
```

(`set -a` marks subsequently-set variables for export; `set +a` turns that back
off. So everything `source` reads from `.env` becomes available to the commands
and containers below.)

### 1. Create the shared network and volume

Compose creates these automatically; manually, you do it first.

```bash
docker network create cms-network
docker volume create members-db-data
```

A shared network lets containers reach each other **by name**. The named volume
is where Postgres data persists.

### 2. Start Postgres

```bash
docker run -d \
  --name members-db \
  --network cms-network \
  --env-file .env \
  -p 5432:5432 \
  -v members-db-data:/var/lib/postgresql/data \
  postgres:16-alpine
```

| Flag              | Meaning                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------- |
| `-d`              | detached (runs in the background)                                                                 |
| `--name`          | container name — also its DNS name on the network                                                 |
| `--network`       | attach to `cms-network` so others can reach it by name                                            |
| `--env-file .env` | load all vars from `.env` (POSTGRES_USER/PASSWORD/DB) into the container — same file Compose uses |
| `-p 5432:5432`    | publish `host:container` port                                                                     |
| `-v name:/path`   | mount the named volume at Postgres's data directory                                               |

Wait until it's accepting connections (this is what Compose's healthcheck did for
you):

```bash
docker exec members-db pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"
# repeat until it prints: ... accepting connections
```

### 3. Build the members-service image

```bash
docker build \
  -f apps/members-service/Dockerfile \
  -t church-cms-members-service:latest \
  .
```

The trailing `.` is the build context (the monorepo root — the Dockerfile needs
the root lockfile and workspace config). `-f` points at the Dockerfile inside it;
`-t` tags the resulting image.

### 4. Run the migration job (one-shot)

```bash
docker run --rm \
  --name members-migrate \
  --network cms-network \
  -e DATABASE_URL="postgresql://$POSTGRES_USER:$POSTGRES_PASSWORD@members-db:5432/$POSTGRES_DB" \
  church-cms-members-service:latest \
  node_modules/.bin/prisma migrate deploy
```

- `--rm` deletes the container the moment it exits (it's a one-shot job).
- Anything after the image name **overrides the image's default command**
  (`node dist/index.js`). The image's `ENTRYPOINT` (tini) still runs, so this
  becomes `tini -- node_modules/.bin/prisma migrate deploy`.
- `migrate deploy` applies pending migrations and is the production-safe command
  (unlike `migrate dev`, it never generates migrations or prompts).

Check it succeeded:

```bash
echo $?    # 0 = success
```

### 5. Start the members-service

```bash
docker run -d \
  --name members-service \
  --network cms-network \
  -e DATABASE_URL="postgresql://$POSTGRES_USER:$POSTGRES_PASSWORD@members-db:5432/$POSTGRES_DB" \
  -p 3001:3001 \
  church-cms-members-service:latest
```

Test it:

```bash
curl localhost:3001/health
curl localhost:3001/members
```

### 6. Start Adminer

```bash
docker run -d \
  --name adminer \
  --network cms-network \
  -p 8080:8080 \
  adminer
```

Then open <http://localhost:8080> (Server: `members-db`, credentials as above).

### Inspecting (Compose subcommand → raw equivalent)

```bash
docker ps                          # docker compose ps
docker logs -f members-service     # docker compose logs -f members-service
docker inspect --format '{{.State.Health.Status}}' members-db   # health status
docker exec -it members-db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"   # psql into the DB
docker network inspect cms-network # see which containers are attached
```

### Teardown

```bash
# stop and remove containers (members-migrate is already gone thanks to --rm)
docker rm -f members-service adminer members-db

docker network rm cms-network      # remove the network
docker volume rm members-db-data   # remove the volume — deletes DB data (like `down -v`)
```

---

## Notes

### Why service names, not localhost

Inside Docker, each container has its own network namespace, so `localhost` means
_that container itself_ — not your machine and not another container. Containers
on a shared network reach each other by **container/service name**
(`members-db`), which Docker's built-in DNS resolves to the right container.

That's why `DATABASE_URL` differs by context:

- **Inside the stack** (the compose file / raw `docker run`): `@members-db:5432`
- **Running the service directly on your machine** (`pnpm --filter members-service dev`,
  using [`apps/members-service/.env`](../apps/members-service/.env)): `@localhost:5432`,
  because then the service is a host process and the published port `5432:5432`
  bridges it to the container.

### Why migrations run as a separate job

The `members-service` image deliberately does **not** run migrations on startup —
it just runs the app. Schema changes are applied by the separate `members-migrate`
job, which runs `prisma migrate deploy` and exits. `members-service` waits for it
via `depends_on: condition: service_completed_successfully`.

This "run migrations as a job, then start the app" pattern maps directly to a
Kubernetes **init container / Job**, which is how it'll be done when the stack
moves to minikube (see the K8s stage of the roadmap). Keeping the runtime image
migration-free now means that step is a straight port later.
