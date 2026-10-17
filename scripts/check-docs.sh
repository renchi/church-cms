#!/usr/bin/env bash
# check-docs.sh — catch the documentation mistakes a reviewer would otherwise find.
#
#   scripts/check-docs.sh            check every Markdown file under docs/ (plus CLAUDE.md)
#
# Errors (exit 1) — things that are wrong right now:
#   - a relative link points to a file that doesn't exist        [text](../apps/x.ts)
#   - a line link points past the end of its file                [text](../apps/x.ts#L300)
#   - a link's label and its line disagree                       [`x.ts:29`](../apps/x.ts#L31)
#
# Warnings (exit 0) — things only a human can judge, computed from this branch's
# diff against main (skipped when main isn't available, e.g. CI's shallow clone):
#   - a doc links to a line in a file this branch changed: the line may have moved
#   - code changed but docs/study-guide.md didn't (.claude/rules/docs-learning.md)
#
# Why a script: on CMS-18 the review had to "fix code links whose line numbers
# moved". A check that runs every time beats a careful reader who sometimes isn't.
# /verify runs it, and so does CI's lint-typecheck job. See study-guide §12.2.

set -euo pipefail
cd "$(dirname "$0")/.."

errors=0
warnings=0
err()  { printf '\033[31m✘\033[0m %s\n' "$1"; errors=$((errors + 1)); }
warn() { printf '\033[33m!\033[0m %s\n' "$1"; warnings=$((warnings + 1)); }

# Files this branch changed, relative to the repo root. Empty when there's no main
# to compare with; the warnings below then have nothing to look at.
base=$(git merge-base HEAD origin/main 2>/dev/null || git merge-base HEAD main 2>/dev/null || true)
changed=""
if [[ -n "$base" ]]; then
  # Committed changes plus uncommitted ones, so it also works mid-ticket.
  changed=$( { git diff --name-only "$base"; git ls-files --others --exclude-standard; } | sort -u)
fi

# --- 1. Links ----------------------------------------------------------------
mapfile -t docs < <(find docs -name '*.md'; echo CLAUDE.md)
for doc in "${docs[@]}"; do
  dir=$(dirname "$doc")
  # grep -o prints each "[label](target)" on its own line, with -n its line number.
  # Inline links only; reference-style links aren't used in this repo.
  while IFS= read -r match; do
    lineno=${match%%:*}
    link=${match#*:}
    label=${link#[}; label=${label%%](*}
    target=${link##*](}; target=${target%)}
    case "$target" in
      http://* | https://* | mailto:* | '#'* | '') continue ;;   # external or same-page
    esac
    path=${target%%#*}
    anchor=""; [[ "$target" == *'#'* ]] && anchor=${target#*#}
    resolved=$(realpath -m --relative-to=. "$dir/$path")

    if [[ ! -e "$resolved" ]]; then
      err "$doc:$lineno → $target: $resolved does not exist"
      continue
    fi
    # A gitignored file (.env, build output) exists only on this machine: on GitHub
    # and in CI's fresh checkout the link is broken. New, untracked files are fine.
    if git check-ignore -q "$resolved"; then
      err "$doc:$lineno → $target: $resolved is gitignored, so the link only works on this machine"
      continue
    fi

    # Line anchors look like #L52 or #L52-L60 (GitHub's format). Check the last line.
    if [[ "$anchor" =~ ^L([0-9]+)(-L([0-9]+))?$ ]]; then
      last=${BASH_REMATCH[3]:-${BASH_REMATCH[1]}}
      # awk counts the last line even without a trailing newline; wc -l would not.
      length=$(awk 'END { print NR }' "$resolved")
      if ((last > length)); then
        err "$doc:$lineno → $target: $resolved has only $length lines"
      fi
      # A label like `Attendance.ts:52` must name the same line as the anchor.
      if [[ "$label" =~ :([0-9]+) ]]; then
        label_line=${BASH_REMATCH[1]}
        [[ "$anchor" == "L$label_line" || "$anchor" == "L$label_line-"* ]] \
          || err "$doc:$lineno → label says line $label_line but the link goes to #$anchor"
      fi
      # The file changed on this branch, so the line it points at may have moved.
      if grep -qxF "$resolved" <<<"$changed"; then
        warn "$doc:$lineno → $target: $resolved changed on this branch; is line ${anchor#L} still the right one?"
      fi
    fi
  done < <(grep -noE '\[[^]]*\]\([^) ]+\)' "$doc" || true)
done

# --- 2. Study guide ----------------------------------------------------------
# Every ticket updates the study guide (.claude/rules/docs-learning.md). Only a
# warning: a chore branch can have a good reason not to.
if grep -qE '^(apps|packages|charts|k8s|scripts)/' <<<"$changed" \
  && ! grep -qxF 'docs/study-guide.md' <<<"$changed"; then
  warn "code changed on this branch but docs/study-guide.md did not (every ticket updates it)"
fi

# --- Summary -----------------------------------------------------------------
[[ -n "$base" ]] || echo "(no main branch to compare with: skipped the branch-diff warnings)"
if ((errors > 0)); then
  printf '\n%d error(s), %d warning(s)\n' "$errors" "$warnings"
  exit 1
fi
printf '\033[32m✔\033[0m docs OK (%d warning(s))\n' "$warnings"
