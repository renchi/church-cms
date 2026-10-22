#!/usr/bin/env bash
# statusline.sh — the bar at the bottom of the Claude Code terminal, so you can see
# where the ticket is without asking:  CMS-34 · verify ✓ · review ✓ · ci …
#
# Claude Code runs this after each message and shows the first line it prints. It
# passes session info as JSON on stdin; we only need the folder the session is in.
# Wired up in .claude/settings.json ("statusLine"). Reads the record that
# scripts/agent-status.sh writes (study-guide §12.4); never writes anything itself.
#
# It must be fast and must never fail loudly: a broken status line just shows
# nothing, so every error here falls back to printing the branch name.
# Call agent-status.sh by its path next to this file, not `scripts/…` relative to the
# current folder: the session may be in apps/web, and the branch is the same anywhere
# in the repo. Resolve it to an absolute path *before* the cd: $0 may be relative.
repo=$(cd "$(dirname "$0")/.." && pwd)
dir=$(jq -r '.workspace.current_dir // .cwd // empty' 2>/dev/null)
cd "${dir:-$repo}" 2>/dev/null || exit 0

if line=$("$repo/scripts/agent-status.sh" line 2>/dev/null) && [[ -n "$line" ]]; then
  echo "$line"
else
  git branch --show-current 2>/dev/null
fi
