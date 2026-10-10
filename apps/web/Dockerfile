# syntax=docker/dockerfile:1
#
# Multi-stage Dockerfile for the Next.js web frontend.
#
# "Multi-stage" means using several FROM blocks in one file.  Each FROM starts a
# fresh filesystem ("stage").  Earlier stages do the heavy build work; the final
# stage starts from a clean slate and copies only what the app needs to run.
# Result: build tools (compilers, dev dependencies) never end up in the image
# that actually gets deployed.
#
# IMPORTANT: run this build from the MONOREPO ROOT, not this folder, because the
# build needs the root pnpm-lock.yaml and workspace config:
#   docker build -f apps/web/Dockerfile -t church-cms-web .

# =============================================================================
# Stage 1 — builder: install deps and compile the Next.js app
# =============================================================================

# FROM pulls a base image from Docker Hub.
# "node:20-alpine" — official Node.js 20 on Alpine Linux (~5 MB vs ~150 MB for
# the Debian-based default).  Smaller base → smaller final image and a smaller
# attack surface.
# "AS builder" names this stage so the runner stage can reference it with
# --from=builder when copying files.
FROM node:20-alpine AS builder

# pnpm ships inside Node via "corepack" (a tool for managing package managers).
# We pin pnpm 9 to match this repo's lockfile (lockfileVersion 9.0).
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

# WORKDIR sets the working directory for all subsequent instructions in this stage.
# "/repo" mirrors the monorepo root path.  Keeping the same absolute path means
# pnpm workspace symlinks (which encode paths) resolve correctly inside the image.
WORKDIR /repo

# ── Layer-cache optimisation ─────────────────────────────────────────────────
# Docker runs each instruction as a separate "layer" and caches the result.
# If nothing in a layer changed since the last build, Docker reuses that cached
# layer instead of re-running the command.
#
# "pnpm install" can take 30–60 s.  If we copy ALL source files first and then
# run install, any source-file change busts the install cache.  Instead we copy
# ONLY the manifest files, run install (cached as long as manifests don't
# change), and copy source files afterwards.  Typical result: install is skipped
# on 95 % of rebuilds — only code compilation re-runs.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
# pnpm-workspace.yaml declares "apps/*" as workspace packages.  pnpm validates
# the lockfile against EVERY package in the workspace — not just the one being
# built.  We must copy all sibling package.json files so pnpm can resolve the
# full workspace graph, even though we won't build those packages here.
COPY apps/web/package.json            ./apps/web/package.json
COPY apps/members-service/package.json ./apps/members-service/package.json
COPY apps/events-service/package.json  ./apps/events-service/package.json

# --frozen-lockfile fails the build if pnpm-lock.yaml is out of date.
# This guarantees the container always uses exactly the versions that were
# tested, with no silent upgrades.
RUN pnpm install --frozen-lockfile

# Source files change on every commit — this layer is almost never cached,
# and that's intentional: the slow install step above is already behind the
# cache boundary.
COPY apps/web ./apps/web

# "next build" compiles the React/TypeScript source into an optimised
# production bundle.  Output lands in apps/web/.next/.
#
# Note on NEXT_PUBLIC_ variables:
#   Variables prefixed NEXT_PUBLIC_ are inlined into client-side JS bundles
#   at build time.  If NEXT_PUBLIC_MEMBERS_API_URL is not set here, client
#   bundles will see undefined for it — but that is fine for our app today,
#   because the members page is a Server Component (it runs on the server,
#   not in the browser) and reads the env var at request time, not build time.
#   If you ever add a client component that calls the API directly, you will
#   need to pass this value as a build ARG:
#     ARG NEXT_PUBLIC_MEMBERS_API_URL
#     ENV NEXT_PUBLIC_MEMBERS_API_URL=$NEXT_PUBLIC_MEMBERS_API_URL
RUN pnpm --filter web build

# =============================================================================
# Stage 2 — runner: a clean, minimal image that only runs the compiled app
# =============================================================================

# A second FROM starts a brand-new filesystem — the builder's layers (including
# all dev dependencies and source files) are gone.  We again use node:20-alpine
# so the runtime environment is consistent with the build environment.
FROM node:20-alpine AS runner

# Why no "RUN apk add tini" here?
#
# Normally we'd install tini (a minimal PID 1 init process) to handle two things:
#   1. Signal forwarding — "docker stop" sends SIGTERM to PID 1; without an init
#      process, Node never receives it and is force-killed after 10 s.
#   2. Zombie reaping — collecting exit status of finished child processes.
#
# Instead, we delegate this to Docker via "init: true" in docker-compose.yml.
# Docker ships with its own tini binary (/usr/bin/docker-init on the host) and
# injects it as PID 1 when "init: true" is set — identical behaviour, zero APK.
#
# The members-service installs tini via "apk add" in its Dockerfile; either
# approach is valid.  The Dockerfile approach makes the image self-contained
# (works with bare "docker run").  The compose approach works for our local
# dev stack and avoids a network call to the Alpine package registry.

# Keep the same absolute path as the builder.  pnpm stores packages once in
# /repo/node_modules and creates symlinks in the app folder pointing there.
# If we changed the path, the symlinks would break.
WORKDIR /repo/apps/web

# NODE_ENV=production tells Next.js and React to enable optimisations and
# disable dev-only warnings and source-map generation.
ENV NODE_ENV=production

# COPY --from=builder pulls files from the "builder" stage, not the host.
# --chown=node:node sets ownership to the "node" user (explained below) so
# the app can read its own files after we drop privileges.
#
# Four things are needed at runtime:
#   /repo/node_modules        — the real package store; all installed packages
#                               live here (including Next.js itself).
#   ./node_modules            — the app's own folder: pnpm workspace symlinks
#                               that point into the store above.
#   ./.next                   — the compiled bundle: server components, client
#                               chunks, route manifests, and pre-rendered HTML.
#   ./package.json            — "next start" reads the project config from here.
COPY --from=builder --chown=node:node /repo/node_modules          /repo/node_modules
COPY --from=builder --chown=node:node /repo/apps/web/node_modules ./node_modules
COPY --from=builder --chown=node:node /repo/apps/web/.next        ./.next
COPY --from=builder --chown=node:node /repo/apps/web/package.json ./package.json

# Switch to the unprivileged "node" user that ships with the base image.
# If an attacker exploits a bug in the app, they get a limited user instead
# of root access to the container host.
USER node

# EXPOSE documents which port the app listens on.  It does NOT publish the port
# or make it reachable from outside — that happens via "ports:" in docker-compose.
EXPOSE 3000

# HEALTHCHECK tells Docker how to test whether the container is working.
# We probe the root path and treat any sub-500 status as healthy (Next.js
# returns 200 for pages, 404 for unknown routes — both mean the server is up).
# Node's built-in http module is used so we don't need curl installed.
#   --start-period=15s  don't count early failures while Next.js is warming up
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000',r=>process.exit(r.statusCode<500?0:1)).on('error',()=>process.exit(1))"

# CMD is the default command run when the container starts.
# "next start -p 3000" launches the production Next.js server.
# docker-compose.override.yml overrides this to "next dev" for hot-reload.
#
# No ENTRYPOINT here: tini is provided by Docker Compose ("init: true" in
# docker-compose.yml) rather than installed in the image.  Docker injects
# it as PID 1 transparently — our CMD becomes tini's child process.
CMD ["node_modules/.bin/next", "start", "-p", "3000"]
