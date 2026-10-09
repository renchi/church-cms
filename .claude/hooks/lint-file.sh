#!/usr/bin/env bash
# PostToolUse hook: lint only the file Claude just edited.
#
# Claude Code passes the tool call as JSON on stdin; we read tool_input.file_path.
# Non-TS files (docs, YAML, JSON) are skipped. ESLint runs from the file's own
# package so per-package configs (e.g. apps/web's Next.js rules) apply.
#
# Exit code 2 + stderr is how a hook feeds problems back to Claude so it fixes
# them; plain stdout would only be visible in the transcript view.
set -euo pipefail

file=$(jq -r '.tool_input.file_path // empty')
case "$file" in
  *.ts | *.tsx | *.mts | *.mjs) ;;
  *) exit 0 ;;
esac

repo="$(cd "$(dirname "$0")/../.." && pwd)"
pkg=$(printf '%s\n' "$file" | sed -nE "s#^$repo/((apps|packages)/[^/]+)/.*#\1#p")
cd "$repo/${pkg:-.}"

if ! out=$(pnpm exec eslint "$file" 2>&1); then
  printf 'ESLint found problems in %s:\n%s\n' "$file" "$(printf '%s\n' "$out" | head -30)" >&2
  exit 2
fi
