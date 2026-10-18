import { fileURLToPath } from 'node:url'

/** @type {import('next').NextConfig} */
const nextConfig = {
  // "standalone": next build also writes .next/standalone/, a folder that runs on
  // its own with `node server.js`. Next traces which files the server actually
  // imports and copies only those (a trimmed node_modules), so the Docker image
  // doesn't need the whole monorepo's node_modules (CMS-33: 1.3 GB → see
  // apps/web/Dockerfile).
  output: 'standalone',
  // Tracing starts from here instead of apps/web. In a pnpm workspace the real
  // package files live in the monorepo root's node_modules (apps/web/node_modules
  // only holds symlinks), so tracing has to be allowed to reach them. The
  // standalone folder then mirrors the monorepo: the server is at
  // .next/standalone/apps/web/server.js.
  outputFileTracingRoot: fileURLToPath(new URL('../../', import.meta.url)),
}

export default nextConfig
