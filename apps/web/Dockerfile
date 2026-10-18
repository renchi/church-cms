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

# The web app doesn't need openssl (that's for the services' Prisma engine). It's
# here only so this builder matches the services' builders step for step up to
# "pnpm install", and the three share one cached install layer (see the manifest
# COPY lines below). It costs ~3 MB in the builder, and never reaches the runner.
RUN apk add --no-cache openssl

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
# pnpm validates the lockfile against every workspace package (apps/*), so every
# app's manifest is copied, not just this one. SAME lines in the SAME order in all
# three Dockerfiles (members-service, events-service, web), from FROM down to
# "pnpm install": identical steps make an identical install layer, which the three
# builds then share as ONE cache entry (~930 MB) instead of three (CMS-33).
COPY apps/events-service/package.json  ./apps/events-service/package.json
COPY apps/members-service/package.json ./apps/members-service/package.json
COPY apps/web/package.json             ./apps/web/package.json

# --frozen-lockfile fails the build if pnpm-lock.yaml is out of date.
# This guarantees the container always uses exactly the versions that were
# tested, with no silent upgrades.
# The shared @cms/events package (ADR-0010) is copied WHOLE, source included,
# before the install: pnpm runs its "prepare" script (tsc) during install, which
# builds packages/events/dist. It's small and rarely changes, so this costs
# little caching.
COPY packages/events                   ./packages/events
RUN pnpm install --frozen-lockfile

# Source files change on every commit — this layer is almost never cached,
# and that's intentional: the slow install step above is already behind the
# cache boundary.
COPY apps/web ./apps/web

# "next build" compiles the React/TypeScript source into an optimised
# production bundle.  Output lands in apps/web/.next/.
#
# Note on env vars and build time:
#   Variables prefixed NEXT_PUBLIC_ are inlined into client-side JS bundles
#   at build time, so they would need a build ARG here. We deliberately have
#   none: MEMBERS_API_URL is a cluster-internal address that only server code
#   reads (the members pages and the registration Server Action, via
#   lib/membersApi.ts), and it is read at request time from the Pod's env
#   (charts/web values.yaml → config.membersApiUrl). No build ARG, and one image
#   works in every environment.
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

# The standalone folder (below) mirrors the monorepo layout, so the app ends up
# in /app/apps/web.
WORKDIR /app

# NODE_ENV=production tells Next.js and React to enable optimisations and
# disable dev-only warnings and source-map generation.
ENV NODE_ENV=production
# The standalone server listens on $HOSTNAME:$PORT. When an image doesn't set
# HOSTNAME, the container runtime (Docker, or the one under Kubernetes) fills it
# in with the container's hostname (in K8s, the Pod name), and the server would
# listen only on that name's address: the HEALTHCHECK's "localhost" below would
# be refused. An ENV in the image takes precedence over that default.
# 0.0.0.0 = every interface. These two lines are the one place the listen address
# is set: charts/web's containerPort, probes and Service targetPort all say 3000.
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

# COPY --from=builder pulls files from the "builder" stage, not the host.
# --chown=node:node sets ownership to the "node" user (explained below) so
# the app can read its own files after we drop privileges.
#
# Until CMS-33 this copied the builder's whole /repo/node_modules (every package
# of the monorepo, dev tools included: ~840 MB) and ran "next start". Now
# next.config.mjs sets output: 'standalone', and "next build" writes:
#   .next/standalone/  — server.js plus ONLY the files it imports, found by
#                        tracing (a trimmed node_modules, still with Next.js and
#                        React). It mirrors the monorepo: apps/web/server.js.
#   .next/static/      — the browser's JS/CSS chunks. Standalone leaves these
#                        out (a CDN usually serves them), so we copy them next to
#                        the server, where it serves them itself.
# The app has no public/ folder yet; when it gets one, copy it to
# ./apps/web/public the same way.
COPY --from=builder --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=builder --chown=node:node /repo/apps/web/.next/static     ./apps/web/.next/static

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
# server.js is the production Next.js server that standalone output generates
# (it replaces "next start", whose CLI isn't in the trimmed node_modules).
# docker-compose.override.yml builds the "builder" stage instead and runs
# "next dev" there for hot-reload.
#
# No ENTRYPOINT here: tini is provided by Docker Compose ("init: true" in
# docker-compose.yml) rather than installed in the image.  Docker injects
# it as PID 1 transparently — our CMD becomes tini's child process.
CMD ["node", "apps/web/server.js"]
