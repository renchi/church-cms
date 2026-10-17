#!/usr/bin/env bash
# check-docs.sh — catch the documentation mistakes a reviewer would otherwise find.
#
#   scripts/check-docs.sh            check every Markdown file under docs/ (plus CLAUDE.md)
#
# Errors (exit 1) — things that are wrong right now:
#   - a relative link points to a file that doesn't exist        [text](../apps/x.ts)
#   - a line link points past the end of its file                [text](../apps/x.ts#L300)
#   - a link's label and its line disagree                       [`x.ts:29`](../apps/x.ts#L31)
#   - a line link into a file this branch changed, whose target line's text now
#     sits on another line: it moved (the error names the new line)
#
# Warnings (exit 0) — things only a human can judge. These and the "moved" error
# compare this branch with main, so they're skipped when main isn't available
# (e.g. CI's shallow clone):
#   - a line link into a changed file whose target line's text changed: is the
#     doc's sentence still true? (both versions are printed)
#   - a line link added on this branch: its target text is printed to confirm
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

# Line $n of a file, without leading/trailing whitespace. Reads stdin.
# It reads to the end on purpose (no `exit`, no `grep -q` below): stopping early
# kills the writer (`git show`) with SIGPIPE, and pipefail turns that into a failure.
line_text() { awk -v n="$1" 'NR == n { gsub(/^[ \t]+|[ \t]+$/, ""); print }'; }

# A line link into a file this branch changed. Decide what we can mechanically,
# so only real judgement calls are left as warnings:
#   - the link already existed on main and its line still holds the same text → fine
#   - that text now sits on exactly one other line                       → error: it moved
#   - the text changed or is gone                                         → warning, old vs new
#   - the link is new on this branch                                      → warning with the target text
# (CMS-26: a pre-existing link to Member.ts:117 silently moved to 124, and 16
# "is line N still right?" warnings each had to be opened by hand.)
check_moved_line() {
  local doc=$1 lineno=$2 target=$3 file=$4 n=$5 now old matches
  now=$(line_text "$n" <"$file")
  # "New" = this link appears more often in the doc now than on main (a second
  # link to the same line elsewhere is new too, and gets confirmed like one).
  local before after
  before=$(git show "$base:$doc" 2>/dev/null | grep -cF "($target)" || true)
  after=$(grep -cF "($target)" "$doc" || true)
  if (( after > before )) || ! git cat-file -e "$base:$file" 2>/dev/null; then
    warn "$doc:$lineno → $target: new link, points at: ${now:-<blank line>}"
    return
  fi
  old=$(git show "$base:$file" | line_text "$n")
  [[ "$now" == "$old" ]] && return
  # Short lines ("}", "") match all over a file, so only trust a distinctive one.
  if (( ${#old} >= 12 )); then
    # Via ENVIRON, not `awk -v`: -v turns backslashes in the text (\d, \n) into escapes.
    matches=$(T="$old" awk '{ s = $0; gsub(/^[ \t]+|[ \t]+$/, "", s) } s == ENVIRON["T"] { print NR }' "$file")
    if [[ -n "$matches" && "$matches" != *$'\n'* ]]; then
      err "$doc:$lineno → $target: the line it pointed at moved to L$matches (${old:0:60})"
      return
    fi
  fi
  warn "$doc:$lineno → $target: line $n changed. Was: ${old:0:60} · Now: ${now:-<blank line>}"
}

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
      first=${BASH_REMATCH[1]}   # saved now: the label match below resets BASH_REMATCH
      last=${BASH_REMATCH[3]:-$first}
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
        check_moved_line "$doc" "$lineno" "$target" "$resolved" "$first"
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
