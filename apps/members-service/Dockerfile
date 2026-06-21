#
# Multi-stage Dockerfile for the Members service.
#
# "Multi-stage" means using several FROM blocks in one file. Each FROM starts a
# fresh filesystem ("stage"). Earlier stages do the heavy build work; the final
# stage starts from a clean slate and copies only what the app needs to run.
# Result: build tools (compilers, dev dependencies) never end up in the image
# that actually gets deployed.
#
# IMPORTANT: run this build from the MONOREPO ROOT, not this folder, because the
# build needs the root pnpm-lock.yaml and workspace config:
#   docker build -f apps/members-service/Dockerfile -t members-service .

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
COPY apps/members-service/package.json ./apps/members-service/package.json
# pnpm validates the lockfile against every workspace package (apps/*).
# Copy the web app's manifest so pnpm can resolve the full workspace graph.
COPY apps/web/package.json             ./apps/web/package.json
RUN pnpm install --frozen-lockfile
# --frozen-lockfile = fail if pnpm-lock.yaml is out of date. Ensures the build
# always uses exactly the versions that were tested, with no silent upgrades.

# Now that deps are installed (and cached), copy the source code.
# Source files change on every commit, so this layer is never reused — and that's
# fine, because the slow install above is already cached.
COPY apps/members-service/tsconfig.json ./apps/members-service/tsconfig.json
COPY apps/members-service/prisma        ./apps/members-service/prisma
COPY apps/members-service/src           ./apps/members-service/src

# Generate the Prisma client: reads schema.prisma and writes two things into
# node_modules — (1) TypeScript types for our DB models, and (2) a platform-
# specific query-engine binary (.so.node file) for the current OS + OpenSSL.
RUN pnpm --filter members-service exec prisma generate

# Compile TypeScript → JavaScript. Output lands in apps/members-service/dist/.
RUN pnpm --filter members-service build

# =============================================================================
# Stage 2 — runner: a clean image that only contains what the app needs to run
# =============================================================================

# A second FROM starts a brand-new filesystem — the builder's layers are gone.
# We again use node:20-alpine so the base is consistent.
FROM node:20-alpine AS runner

# openssl: the Prisma query engine (copied from the builder) needs libssl at runtime.
# tini: a tiny "init" process (PID 1 manager). Explained more below at ENTRYPOINT.
RUN apk add --no-cache openssl tini

# Keep the SAME absolute path as the builder. pnpm doesn't copy packages into
# each app folder; it stores them once in /repo/node_modules and the service
# folder has symlinks pointing there. Preserving the path means symlinks resolve.
WORKDIR /repo/apps/members-service

# ENV sets an environment variable that persists into the running container.
# NODE_ENV=production tells Node.js and most libraries to disable debug output,
# enable performance optimisations, and skip dev-only checks.
ENV NODE_ENV=production

# COPY --from=builder pulls files from the "builder" stage, not the host machine.
# --chown=node:node sets file ownership to the "node" user (ships with the base
# image) so our app can read its own files when we switch to that user below.
#
# We copy four things:
#   /repo/node_modules       — the real package store: all installed packages live
#                              here, including the Prisma client + engine binary
#   ./node_modules           — the service's own folder: symlinks that point into
#                              the store above (this is how pnpm workspaces work)
#   ./dist                   — our compiled JavaScript (output of "tsc")
#   ./prisma                 — the schema, kept so "prisma migrate deploy" can run later
COPY --from=builder --chown=node:node /repo/node_modules                 /repo/node_modules
COPY --from=builder --chown=node:node /repo/apps/members-service/node_modules ./node_modules
COPY --from=builder --chown=node:node /repo/apps/members-service/dist         ./dist
COPY --from=builder --chown=node:node /repo/apps/members-service/prisma       ./prisma

# Switch to the unprivileged "node" user for all instructions from here on.
# Best practice: if an attacker exploits a bug in our app, they get a limited
# user — not root access to the container host.
USER node

# EXPOSE documents which port the app listens on. Important: it does NOT actually
# publish the port or make it reachable. That happens at runtime with:
#   docker run -p 3001:3001 members-service   (host-port:container-port)
# or via the "ports:" key in docker-compose.yml.
EXPOSE 3001

# HEALTHCHECK tells Docker how to test whether the container is working.
# Docker runs this command on a schedule and marks the container "healthy" or
# "unhealthy" based on the exit code (0 = healthy, non-zero = unhealthy).
# We use Node's built-in http module so we don't need curl installed.
#   --interval=30s   run the check every 30 seconds
#   --timeout=3s     if the check takes longer than 3s, treat it as a failure
#   --start-period=10s  don't count failures during the first 10s (app is booting)
#   --retries=3      mark unhealthy only after 3 consecutive failures
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3001/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# ENTRYPOINT and CMD work together — understanding the difference matters:
#
#   ENTRYPOINT defines the executable that always runs. It cannot be overridden
#   by arguments passed to "docker run" (unless you use --entrypoint explicitly).
#
#   CMD defines the default arguments passed to the ENTRYPOINT. It CAN be
#   overridden: "docker run members-service node some-other-script.js" replaces CMD.
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
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
