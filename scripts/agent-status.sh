#!/usr/bin/env bash
# agent-status.sh — the status record for the ticket in progress: what stage each
# workflow step is at, so "is the review done? is CI done?" has an answer any time.
#
#   scripts/agent-status.sh [--ticket CMS-34] set <stage> <state> [note]
#   scripts/agent-status.sh [--ticket CMS-34] run <stage> -- <command…>
#   scripts/agent-status.sh [--ticket CMS-34] pr <number>
#   scripts/agent-status.sh [--ticket CMS-34] show
#   scripts/agent-status.sh [--ticket CMS-34] line
#
#   stages: start plan implement verify review ci merge deploy done
#   states: pending running waiting done failed
#
# Why: long steps (CI watch, Deploy watch, cluster-up) now run in the background, so
# the chat stays free (study-guide §12.4). The agent no longer "remembers" where a
# step is: this record does. /status, the status line and you all read the same file.
#
# Where: .claude/state/<ticket>.json (gitignored). The ticket comes from the branch
# (cms-34/… → CMS-34; any other branch → its name with / as -, e.g. chore/x → chore-x).
# On main, `show` and `line` use the most recently updated record, and writes need
# --ticket. AGENT_STATUS_DIR overrides the folder (the runbook exercises use it to
# stay out of the real records).
#
# Permissions: .claude/settings.json allows `set`, `pr`, `show`, `line` and the exact
# `run` commands the skills use, nothing wider. `run` executes whatever follows `--`,
# so `run *` would let any command skip the prompt, `gh pr merge` included.
#
# `run` is the key piece: it marks the stage running, runs the command, and records
# done/failed from the exit code itself. The record stays right even if the agent is
# busy with something else, or the chat turn that started it has ended.
# shellcheck disable=SC2016  # the jq filters are single-quoted on purpose: jq expands $vars, not bash
set -euo pipefail
# Resolve AGENT_STATUS_DIR *before* the cd below: a relative path means relative to
# where you ran the command, not to the repo root (where it could get committed).
[[ -n "${AGENT_STATUS_DIR:-}" ]] && AGENT_STATUS_DIR=$(realpath -m "$AGENT_STATUS_DIR")
cd "$(dirname "$0")/.."

state_dir="${AGENT_STATUS_DIR:-.claude/state}"
stages=(start plan implement verify review ci merge deploy "done")
states=(pending running waiting "done" failed)

die() { echo "agent-status: $1" >&2; exit 2; }
now() { date -u +%FT%TZ; }
in_list() { local x=$1; shift; for v in "$@"; do [[ "$v" == "$x" ]] && return 0; done; return 1; }

ticket=""
if [[ "${1:-}" == "--ticket" ]]; then
  ticket="${2:?--ticket needs a value}"
  shift 2
fi
cmd="${1:-show}"
shift || true

# Which record? An explicit --ticket wins, then the branch name: cms-34/… → CMS-34,
# any other branch → its name with / as - (chore/x → chore-x, docs/y → docs-y).
# Only main (and a detached HEAD) has no record of its own.
branch=$(git branch --show-current 2>/dev/null || true)
if [[ -z "$ticket" ]]; then
  if [[ "$branch" =~ ^cms-([0-9]+)/ ]]; then
    ticket="CMS-${BASH_REMATCH[1]}"
  elif [[ -n "$branch" && "$branch" != "main" ]]; then
    ticket="${branch//\//-}"
  fi
fi
branch="${branch:-?}"
mkdir -p "$state_dir"

# Reading on main (just after a merge): fall back to the newest record.
if [[ -z "$ticket" && ( "$cmd" == "show" || "$cmd" == "line" ) ]]; then
  # shellcheck disable=SC2012  # our own file names (CMS-34.json), so ls -t is safe
  newest=$(ls -t "$state_dir"/*.json 2>/dev/null | head -1 || true)
  [[ -z "$newest" ]] && { [[ "$cmd" == "show" ]] && echo "No status records yet."; exit 0; }
  ticket=$(basename "$newest" .json)
fi
[[ -n "$ticket" ]] || die "on main, writes need --ticket CMS-<n> (or the branch's key, e.g. chore-x)"
file="$state_dir/$ticket.json"

# Every write goes through here. Two writers can overlap (a background `run` finishing
# while the agent runs `set`), so: take a lock, apply one jq filter to the current
# record, write a temp file, then `mv` it into place. A reader never sees half a file,
# because `mv` within one folder swaps it in one step.
update() {
  local filter=$1; shift
  (
    flock 9
    [[ -f "$file" ]] || jq -n --arg t "$ticket" --arg b "$branch" \
      '{ticket:$t, branch:$b, pr:null, updated:null, stages:{}}' > "$file"
    jq --arg now "$(now)" "$@" "$filter | .updated = \$now" "$file" > "$file.tmp"
    mv "$file.tmp" "$file"
  ) 9> "$file.lock"
}

set_stage() {   # set_stage <stage> <state> <note> [pid]
  in_list "$1" "${stages[@]}" || die "unknown stage '$1' (one of: ${stages[*]})"
  in_list "$2" "${states[@]}" || die "unknown state '$2' (one of: ${states[*]})"
  update '.stages[$s] = {state:$st, note:$n, at:$now} + (if $p == "" then {} else {pid:($p|tonumber)} end)' \
    --arg s "$1" --arg st "$2" --arg n "$3" --arg p "${4:-}"
}

# A `running` stage is only true while its process lives. If the process is gone but
# the record still says running, the record is stale: the session that ran it ended,
# or it was killed with SIGKILL (which can't be trapped). The record says what was
# last written; `kill -0` says what's true now. Both matter.
#   Limitation: PIDs get reused, so on a busy machine a stale stage could look alive.
#   Fine for one laptop; Part 2's orchestrator will track its own jobs instead.
alive() { kill -0 "$1" 2>/dev/null; }

# Field separator for reading jq rows into variables. Not a tab: tab counts as IFS
# whitespace, so `read` merges two tabs into one and an empty field (no pid) shifts
# every later field over. The ASCII unit separator (0x1f) is never merged.
US=$'\x1f'

case "$cmd" in
  set)
    [[ $# -ge 2 ]] || die "usage: set <stage> <state> [note]"
    set_stage "$1" "$2" "${3:-}"
    ;;

  pr)
    [[ "${1:-}" =~ ^[0-9]+$ ]] || die "usage: pr <number>"
    update '.pr = ($n|tonumber)' --arg n "$1"
    ;;

  run)
    stage="${1:?usage: run <stage> -- <command…>}"; shift
    [[ "${1:-}" == "--" ]] && shift
    [[ $# -gt 0 ]] || die "usage: run <stage> -- <command…>"
    # Check the stage *before* starting anything: a typo must not leave the command
    # running with no record of it.
    in_list "$stage" "${stages[@]}" || die "unknown stage '$stage' (one of: ${stages[*]})"
    # SIGTERM/SIGINT/SIGHUP (Ctrl+C, a closed terminal, `kill <pid>`) can be caught:
    # stop the command and record why. SIGKILL can't be caught; `show` reports that
    # case as stale. Set the trap before starting the command, so no signal slips
    # through the gap between the two.
    child=""
    trap '[[ -n "$child" ]] && kill "$child" 2>/dev/null; set_stage "$stage" failed "interrupted: $*"; exit 143' TERM INT HUP
    # Run the command as a child and `wait` for it, rather than exec-ing it, so this
    # script is still here to record the result. `$$` is this script's PID: the one
    # that must stay alive for the record to be updated.
    "$@" &
    child=$!
    set_stage "$stage" running "$*" "$$"
    set +e
    wait "$child"
    code=$?
    set -e
    trap - TERM INT HUP
    if [[ $code -eq 0 ]]; then
      set_stage "$stage" "done" "$*"
    else
      set_stage "$stage" failed "exit $code: $*"
    fi
    exit "$code"
    ;;

  show)
    [[ -f "$file" ]] || { echo "$ticket: no status record yet."; exit 0; }
    jq -r '"\(.ticket)  branch \(.branch)" + (if .pr then "  PR #\(.pr)" else "" end) + "  (updated \(.updated))"' "$file"
    for s in "${stages[@]}"; do
      row=$(jq -r --arg s "$s" '.stages[$s] // empty | [.state, (.pid // "" | tostring), .at, .note] | join("\u001f")' "$file")
      [[ -z "$row" ]] && continue
      IFS=$US read -r st pid at note <<< "$row"
      if [[ "$st" == "running" && -n "$pid" ]] && ! alive "$pid"; then
        st="stale"; note="process $pid is gone (session ended?) — re-check: $note"
      fi
      printf '  %-10s %-8s %s  %s\n' "$s" "$st" "$at" "$note"
    done
    ;;

  line)
    # One compact line for the status line: done ✓, running …, waiting ⏸, failed ✗, stale ?.
    [[ -f "$file" ]] || { echo "$ticket"; exit 0; }
    out="$ticket"
    for s in "${stages[@]}"; do
      row=$(jq -r --arg s "$s" '.stages[$s] // empty | [.state, (.pid // "" | tostring)] | join("\u001f")' "$file")
      [[ -z "$row" ]] && continue
      IFS=$US read -r st pid <<< "$row"
      [[ "$st" == "running" && -n "$pid" ]] && ! alive "$pid" && st="stale"
      case "$st" in
        done) mark="✓" ;; running) mark="…" ;; waiting) mark="⏸ waiting for you" ;;
        failed) mark="✗" ;; stale) mark="? stale" ;; *) mark="" ;;
      esac
      out+=" · $s $mark"
    done
    echo "$out"
    ;;

  *)
    die "unknown command '$cmd' (set, run, pr, show, line)"
    ;;
esac
