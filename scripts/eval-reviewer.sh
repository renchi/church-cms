#!/usr/bin/env bash
# eval-reviewer.sh — measure code reviewers against bugs planted where only an answer key
# knows them (study-guide §12.5, docs/agents.md).
#
#   scripts/eval-reviewer.sh setup      new worktree ../church-cms-eval on branch eval/reviewer-planted
#   scripts/eval-reviewer.sh inputs     its diff + changed files → .claude/state/eval/
#   scripts/eval-reviewer.sh score      score .claude/state/eval/runs/*.json against the key
#   scripts/eval-reviewer.sh teardown   remove the worktree and the branch
#
# The whole eval (docs/agents.md §4):
#   setup → the bug-planter agent writes a feature with 3–5 bugs in the worktree and seals
#   the key → inputs → each reviewer arm runs and its findings are saved as runs/<arm>-<n>.json
#   → score → a human labels the unmatched findings → teardown.
#
# Why a separate worktree: `git worktree add` makes a second working folder that shares
# this repo's .git. The planter can commit on its own branch there while this folder stays
# on the ticket branch, untouched. Two writers never share one folder (ADR-0011).
#
# Why the key lives outside the repo: every reviewer can Read the repo. A key inside it
# (or a doc describing the bugs) would hand them the answers. The branch is never pushed
# for the same reason: the repo is public.
#
# Run file format (one per review run), written by the orchestrating session:
#   {"arm":"arm3","run":1,"tokens":48210,"findings":[{"file":"…","line":42,"summary":"…", …}]}
# The findings are the reviewer's JSON block, copied as-is; `tokens` is the agent's
# total_tokens as the Agent tool reported it.
#
# Overrides: EVAL_WORKTREE (default ../church-cms-eval), EVAL_KEY (default
# ${XDG_CACHE_HOME:-~/.cache}/church-cms-eval/key.json), EVAL_SLACK (default 5 lines).
set -euo pipefail
cd "$(dirname "$0")/.."

branch="eval/reviewer-planted"
worktree=$(realpath -m "${EVAL_WORKTREE:-../church-cms-eval}")
key="${EVAL_KEY:-${XDG_CACHE_HOME:-$HOME/.cache}/church-cms-eval/key.json}"
eval_dir=".claude/state/eval"   # gitignored with the rest of .claude/state/
slack="${EVAL_SLACK:-5}"

die() { echo "eval-reviewer: $1" >&2; exit 2; }

case "${1:-}" in
  setup)
    [[ -e "$worktree" ]] && die "$worktree already exists; run teardown first"
    git show-ref --quiet "refs/heads/$branch" && die "branch $branch already exists; run teardown first"
    # Start from main, not from this ticket branch: the planted change must be the only
    # thing in the diff the reviewers see.
    git worktree add "$worktree" -b "$branch" main
    # A key left over from an earlier eval would score this one against the wrong bugs.
    rm -f "$key"
    mkdir -p "$(dirname "$key")" "$eval_dir/runs"
    rm -f "$eval_dir"/runs/*.json
    echo "worktree: $worktree"
    echo "key file: $key   (the planter writes it; don't read it until every run is scored)"
    ;;

  inputs)
    [[ -d "$worktree" ]] || die "no worktree at $worktree; run setup first"
    scripts/review-input.sh --repo "$worktree" "$eval_dir"
    echo "next: write the planter's feature description to $eval_dir/ticket.md"
    ;;

  score)
    [[ -f "$key" ]] || die "no key at $key (did the planter write it?)"
    shopt -s nullglob
    runs=("$eval_dir"/runs/*.json)
    [[ ${#runs[@]} -gt 0 ]] || die "no run files in $eval_dir/runs/"
    total=$(jq length "$key")
    echo "key: $total planted bugs; a finding catches a bug if it names the same file within ±$slack lines of it"
    echo
    rows=()
    for f in "${runs[@]}"; do
      # Reject a run whose findings don't have the shape we score. Better a loud
      # "rejected" than a silent 0 that looks like a reviewer that found nothing.
      if ! jq -e '(.arm|type=="string") and (.findings|type=="array")
                  and all(.findings[]; (.file|type=="string") and (.line|type=="number"))' "$f" >/dev/null 2>&1; then
        echo "$(basename "$f" .json): REJECTED — not {arm, findings:[{file, line:number, …}]}"
        continue
      fi
      # One jq pass per run. For each finding, the bugs it hits; then:
      #   caught    = distinct bug ids hit by any finding (a bug counts once, however many
      #               findings point at it; a finding counts for every bug it hits)
      #   unmatched = findings that hit no bug: false alarm, real-but-not-planted, or nit,
      #               which a human labels (a script can't tell those apart)
      row=$(jq -r --slurpfile key "$key" --argjson slack "$slack" '
        def hits($f): [$key[0][] | select(.file == $f.file
                         and $f.line >= (.line_start - $slack) and $f.line <= (.line_end + $slack)) | .id];
        (.findings | map(. + {hits: hits(.)})) as $fs
        | ($fs | map(.hits[]) | unique) as $caught
        | [ .arm, (.run|tostring), ($caught|length|tostring), ($caught|join(" ")),
            ($fs | map(select(.hits == [])) | length | tostring), ((.tokens // 0)|tostring) ]
        | join("\u001f")' "$f")
      # Split on the ASCII unit separator, not a tab: an empty field (nothing caught) between
      # two tabs collapses and shifts every later field (the same trap as agent-status.sh).
      IFS=$'\x1f' read -r arm run caught ids unmatched tokens <<< "$row"
      printf '%-8s caught %s/%s %-14s unmatched %-3s tokens %s\n' "$arm-$run" "$caught" "$total" "(${ids:--})" "$unmatched" "$tokens"
      jq -r --slurpfile key "$key" --argjson slack "$slack" '
        .findings[]
        | select([$key[0][] as $k | select($k.file == .file
                   and .line >= ($k.line_start - $slack) and .line <= ($k.line_end + $slack))] == [])
        | "\(.file)\u001f\(.line)\u001f\(.summary)"' "$f" |
      while IFS=$'\x1f' read -r ufile uline usummary; do
        # A line past the end of the file can't be a real location. Seen in CMS-35: a
        # reviewer took line numbers from diff.patch (positions in the patch), not the code.
        hint=""
        if [[ -f "$worktree/$ufile" ]] && (( uline > $(wc -l < "$worktree/$ufile") )); then
          hint="  [line past end of file: from the diff, not the code?]"
        fi
        echo "           ? $ufile:$uline  $usummary$hint"
      done
      rows+=("$arm $caught $unmatched $tokens")
    done
    echo
    echo "per arm (mean, min–max over runs):"
    printf '%s\n' "${rows[@]}" | awk '
      { n[$1]++; for (i = 2; i <= 4; i++) { v = $i; s[$1,i] += v
          if (!(($1,i) in mn) || v < mn[$1,i]) mn[$1,i] = v
          if (!(($1,i) in mx) || v > mx[$1,i]) mx[$1,i] = v } }
      END { split("caught unmatched tokens", name, " ")
        for (a in n) { line = sprintf("  %-6s runs %d", a, n[a])
          for (i = 2; i <= 4; i++) line = line sprintf("   %s %.1f (%d–%d)", name[i-1], s[a,i]/n[a], mn[a,i], mx[a,i])
          print line } }' | sort
    ;;

  teardown)
    # Refuse if the branch somehow reached GitHub: the repo is public, and a pushed
    # planted branch publishes the answers to every future reviewer (and CMS-37's CI agent).
    if git ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1; then
      die "$branch exists on origin: delete it there first (git push origin --delete $branch), then rerun"
    fi
    [[ -d "$worktree" ]] && git worktree remove --force "$worktree"
    git show-ref --quiet "refs/heads/$branch" && git branch -D "$branch"
    echo "removed $worktree and $branch (the key and run files are kept for the write-up)"
    ;;

  *)
    die "usage: eval-reviewer.sh setup|inputs|score|teardown"
    ;;
esac
