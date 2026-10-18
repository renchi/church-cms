#
# Multi-stage Dockerfile for the Events service. A copy of
# apps/members-service/Dockerfile; the differences are marked "events-service:".
#
# "Multi-stage" means using several FROM blocks in one file. Each FROM starts a
# fresh filesystem ("stage"). Earlier stages do the heavy build work; the final
# stage starts from a clean slate and copies only what the app needs to run.
# Result: build tools (compilers, dev dependencies) never end up in the image
# that actually gets deployed.
#
# IMPORTANT: run this build from the MONOREPO ROOT, not this folder, because the
# build needs the root pnpm-lock.yaml and workspace config:
#   docker build -f apps/events-service/Dockerfile -t events-service .

# =============================================================================
# Stage 1 — builder: install deps, generate Prisma client, compile TypeScript
# =============================================================================

# FROM pulls a base image from Docker Hub (hub.docker.com).
# "node:20" = the official Node.js image at version 20.
# "-alpine" = built on Alpine Linux, a stripped-down distro (~5MB vs ~150MB for
#   the default Debian-based image). Smaller base → smaller final image, and a
#   smaller attack surface. The trade-off: Alpine uses musl libc instead of glibc,
#   so some native binaries (like Prisma's engine) must be compiled for musl.
# "AS builder" = names this stage "builder" so the runner stage can reference it.
FROM node:20-alpine AS builder

# RUN executes a shell command while building the image.
# "apk" is Alpine's package manager (like apt on Ubuntu / brew on Mac).
# "--no-cache" skips writing the package index to disk, keeping the layer small.
#
# We install openssl because Prisma's query engine is a native binary that links
# against libssl. Alpine ships OpenSSL 3 but doesn't install it by default;
# without it Prisma can't detect the version and generates the wrong engine.
RUN apk add --no-cache openssl

# pnpm ships inside Node via "corepack" (a tool for managing package managers).
# We pin pnpm 9 to match this repo's lockfile (lockfileVersion 9.0); the newest
# pnpm (11+) needs a Node 22+ built-in (node:sqlite) that doesn't exist in Node 20.
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

# WORKDIR sets the working directory for all subsequent instructions in this stage.
# It's like running "mkdir -p /repo && cd /repo" — creates the folder if needed,
# and makes it the default location for COPY, RUN, and CMD.
WORKDIR /repo

# Layer caching — the most important Docker build performance trick:
# Docker runs each instruction as a separate "layer" and caches the result.
# If nothing in that layer changed, Docker reuses the cache instead of re-running.
# "pnpm install" is slow (~30s+). We copy ONLY the manifest files first and run
# the install. Now that layer is cached. On the next rebuild, if only source code
# changed (not package.json), Docker skips straight past the install.
# If we copied everything first, any source file change would bust this cache.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
# pnpm validates the lockfile against every workspace package (apps/*), so every
# app's manifest is copied, not just this one. SAME lines in the SAME order in all
# three Dockerfiles (members-service, events-service, web), from FROM down to
# "pnpm install": identical steps make an identical install layer, which the three
# builds then share as ONE cache entry (~930 MB) instead of three (CMS-33).
COPY apps/events-service/package.json  ./apps/events-service/package.json
COPY apps/members-service/package.json ./apps/members-service/package.json
COPY apps/web/package.json             ./apps/web/package.json
# The shared @cms/events package (ADR-0010) is copied WHOLE, source included,
# before the install: pnpm runs its "prepare" script (tsc) during install, which
# builds packages/events/dist. It's small and rarely changes, so this costs
# little caching.
COPY packages/events                   ./packages/events
RUN pnpm install --frozen-lockfile
# --frozen-lockfile = fail if pnpm-lock.yaml is out of date. Ensures the build
# always uses exactly the versions that were tested, with no silent upgrades.

# Now that deps are installed (and cached), copy the source code.
# Source files change on every commit, so this layer is never reused — and that's
# fine, because the slow install above is already cached.
COPY apps/events-service/tsconfig.json ./apps/events-service/tsconfig.json
COPY apps/events-service/prisma        ./apps/events-service/prisma
COPY apps/events-service/src           ./apps/events-service/src

# Generate the Prisma client: reads schema.prisma and writes two things —
# (1) TypeScript types for our DB models, and (2) a platform-specific
# query-engine binary (.so.node file) for the current OS + OpenSSL.
# events-service: they go into apps/events-service/generated/client, not into
# node_modules (see the `output` comment in prisma/schema.prisma).
RUN pnpm --filter events-service exec prisma generate

# Compile TypeScript → JavaScript. Output lands in apps/events-service/dist/.
RUN pnpm --filter events-service build

# =============================================================================
# Stage 2 — deploy: pick out only the packages the service needs at runtime
# =============================================================================

# The builder's /repo/node_modules holds EVERY package of the whole monorepo:
# web's Next.js, vitest, Testcontainers, ESLint, TypeScript... ~840 MB. Copying it
# into the runner (as this file did until CMS-33) made each image ~1.3 GB.
#
# "pnpm deploy" builds a standalone folder for ONE workspace package:
#   --filter events-service   which package
#   --prod                     only its "dependencies", none of its "devDependencies"
#   /prod/events-service      where to write it: the app folder, with node_modules
# What goes into that folder besides node_modules is the package's "files" list
# (apps/events-service/package.json): dist, generated and prisma. So /prod/events-service is
# the complete app, and the runner copies it in one step.
# Workspace dependencies (@cms/events) are copied in as real folders instead of
# symlinks into /repo/packages, so the result works from any path. Its
# "files": ["dist"] (packages/events/package.json) limits that copy to the compiled
# code: without it, src/, tsconfig.json and the vitest config come along too.
#
# A separate stage (not more RUN lines in "builder") because docker-compose's dev
# setup stops at "target: builder" and needs the full install there.
FROM builder AS deploy
RUN pnpm --filter events-service deploy --prod /prod/events-service

# =============================================================================
# Stage 3 — runner: a clean image that only contains what the app needs to run
# =============================================================================

# A new FROM starts a brand-new filesystem — the earlier stages' layers are gone.
# We again use node:20-alpine so the base is consistent.
FROM node:20-alpine AS runner

# openssl: the Prisma query engine (copied from the builder) needs libssl at runtime.
# tini: a tiny "init" process (PID 1 manager). Explained more below at ENTRYPOINT.
RUN apk add --no-cache openssl tini

# The deploy stage's output doesn't depend on the monorepo layout, so the app
# lives in a plain /app folder.
WORKDIR /app

# ENV sets an environment variable that persists into the running container.
# NODE_ENV=production tells Node.js and most libraries to disable debug output,
# enable performance optimisations, and skip dev-only checks.
ENV NODE_ENV=production

# COPY --from=<stage> pulls files from an earlier stage, not the host machine.
# --chown=node:node sets file ownership to the "node" user (ships with the base
# image) so our app can read its own files when we switch to that user below.
#
# One COPY: the deploy stage's folder is the whole app. What's in it:
#   ./node_modules — the runtime packages only, including the Prisma CLI that the
#                    migration init container runs (which is why "prisma" is a
#                    dependency, not a devDependency)
#   ./package.json
#   ./dist         — our compiled JavaScript (output of "tsc")
#   ./prisma       — the schema and migrations, for "prisma migrate deploy"
#   ./generated    — the Prisma client, generated into this service's own folder
#                    instead of node_modules (see the `output` comment in
#                    prisma/schema.prisma). It finds @prisma/client's runtime in
#                    ./node_modules, one folder up.
COPY --from=deploy --chown=node:node /prod/events-service ./

# Switch to the unprivileged "node" user for all instructions from here on.
# Best practice: if an attacker exploits a bug in our app, they get a limited
# user — not root access to the container host.
USER node

# EXPOSE documents which port the app listens on. Important: it does NOT actually
# publish the port or make it reachable. That happens at runtime with:
#   docker run -p 3002:3002 events-service   (host-port:container-port)
# or via the "ports:" key in docker-compose.yml.
#   3002 — the API (events-service: members-service has 3001).
#   9465 — Prometheus metrics (/metrics), served by the OpenTelemetry SDK on its
#          own port so it is never routed through the public Ingress.
EXPOSE 3002 9465

# HEALTHCHECK tells Docker how to test whether the container is working.
# Docker runs this command on a schedule and marks the container "healthy" or
# "unhealthy" based on the exit code (0 = healthy, non-zero = unhealthy).
# We use Node's built-in http module so we don't need curl installed.
#   --interval=30s   run the check every 30 seconds
#   --timeout=3s     if the check takes longer than 3s, treat it as a failure
#   --start-period=10s  don't count failures during the first 10s (app is booting)
#   --retries=3      mark unhealthy only after 3 consecutive failures
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3002/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# ENTRYPOINT and CMD work together — understanding the difference matters:
#
#   ENTRYPOINT defines the executable that always runs. It cannot be overridden
#   by arguments passed to "docker run" (unless you use --entrypoint explicitly).
#
#   CMD defines the default arguments passed to the ENTRYPOINT. It CAN be
#   overridden: "docker run events-service node some-other-script.js" replaces CMD.
#
# Here: tini is the ENTRYPOINT (always runs as PID 1), and our server is the CMD
# (the argument tini receives). tini's job as PID 1:
#   1. Forward signals (SIGTERM from "docker stop") to our Node process so it
#      shuts down cleanly instead of being force-killed after a 10s timeout.
#   2. Reap "zombie" child processes (processes that have exited but whose parent
#      hasn't collected their exit status — a Unix housekeeping requirement).
#
# Note: database migrations are intentionally NOT run here. In Kubernetes those
# belong in an init container / Job (see the K8s ticket, CMS-14).
#
# "--import ./dist/instrumentation.js" makes Node run the OpenTelemetry setup
# BEFORE our app code. OTel instruments libraries (http, fastify) by patching
# them as they load, so it has to be first. Preloading with --import is what the
# OTel docs recommend for ESM apps: it guarantees the patches are in place before
# any library loads. See src/instrumentation.ts.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--import", "./dist/instrumentation.js", "dist/index.js"]
