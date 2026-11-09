#!/usr/bin/env bash
# review-input.sh — write what a read-only reviewer needs into files: the branch's diff and
# the list of changed files.
#
#   scripts/review-input.sh [--repo DIR] [--base main] <out-dir>
#
#   writes <out-dir>/diff.patch          everything this branch changed since it left <base>,
#                                        committed or not (see below)
#          <out-dir>/changed-files.txt   one path per line, relative to DIR
#
# Why: the reviewer and docs-auditor subagents (.claude/agents/) have Read, Grep and Glob
# only, and no Bash, so they can't run `git diff` themselves (ADR-0011: the tool list is
# the security boundary). The orchestrating session runs this, writes the ticket text
# beside it as ticket.md, and hands the agent the paths. One extra step buys an agent that
# can't change anything even if a file it reads tells it to.
#
# --repo exists for the eval (scripts/eval-reviewer.sh): it points at a separate git
# worktree, so the diff is the planted branch's, not this folder's.
#
# Normal use (CLAUDE.md Workflow): scripts/review-input.sh .claude/state/CMS-35-review
set -euo pipefail

repo="."
base="main"
while [[ "${1:-}" == --* ]]; do
  case "$1" in
    --repo) repo="${2:?--repo needs a folder}"; shift 2 ;;
    --base) base="${2:?--base needs a ref}"; shift 2 ;;
    *) echo "review-input: unknown option $1" >&2; exit 2 ;;
  esac
done
out="${1:?usage: review-input.sh [--repo DIR] [--base main] <out-dir>}"
mkdir -p "$out"

# Diff from the merge-base (where this branch left <base>) to the *working tree*. That's
# `git diff <base>...HEAD` plus anything staged or edited but not yet committed, because
# /verify runs the docs-auditor before the commit. Starting from the merge-base, not
# <base>'s tip, means commits that landed on main after the branch was cut don't show up
# as "removed".
fork_point=$(git -C "$repo" merge-base "$base" HEAD)
git -C "$repo" diff "$fork_point" > "$out/diff.patch"
git -C "$repo" diff --name-only "$fork_point" > "$out/changed-files.txt"

# git diff only sees files git tracks. A brand-new file that was never `git add`ed is
# missing, so say so rather than hand the reviewer a diff that silently lacks it.
untracked=$(git -C "$repo" ls-files --others --exclude-standard)
if [[ -n "$untracked" ]]; then
  echo "review-input: warning: untracked files are NOT in the diff (git add them):" >&2
  while IFS= read -r f; do echo "  $f" >&2; done <<< "$untracked"
fi

echo "$(wc -l < "$out/changed-files.txt") files, $(wc -l < "$out/diff.patch") diff lines → $out"
