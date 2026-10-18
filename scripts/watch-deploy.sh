#!/usr/bin/env bash
# Watch the Deploy run for a commit, in your own terminal, so /ship doesn't wait on it.
#
#   scripts/watch-deploy.sh          # the Deploy run for origin/main's newest commit
#   scripts/watch-deploy.sh <sha>    # … for a given commit
#
# Why: there's nothing to trigger. Deploy starts by itself when CI passes on main
# (`workflow_run`, docs/ci-cd.md), but a cold build of all three images takes a
# while. /ship used to block the session until it finished; now it prints this
# command and moves on. You watch here, and tell the agent if something breaks.
#
# What it does: waits for the run to appear (it only exists once CI on main has
# finished), warns if the self-hosted runner is offline (jobs would sit in Queued),
# watches the run, then prints each job's result, this machine's free disk (the
# runner builds here) and, on failure, the commands to read logs and re-run.
set -euo pipefail

sha="${1:-}"
if [[ -z "$sha" ]]; then
  git fetch -q origin main
  sha=$(git rev-parse origin/main)
fi
echo "==> Deploy for ${sha:0:7}: $(git log -1 --format=%s "$sha" 2>/dev/null || echo '(commit not fetched)')"

# Filter by commit, not "the newest Deploy run": right after a merge, the newest
# one is still the previous deploy, and watching it would report a false success.
run_id=""
for _ in $(seq 1 40); do   # 40 × 15 s = 10 min, longer than CI on main takes
  run_id=$(gh run list --workflow=Deploy --commit "$sha" --json databaseId -q '.[0].databaseId')
  [[ -n "$run_id" ]] && break
  echo "    waiting for CI on main to finish and start Deploy…"
  sleep 15
done
if [[ -z "$run_id" ]]; then
  echo "✘ no Deploy run for ${sha:0:7} after 10 min. Did CI on main pass?  gh run list --commit $sha" >&2
  exit 1
fi
echo "    run $run_id: $(gh run view "$run_id" --json url -q .url)"

# An offline runner doesn't fail anything: the jobs just wait in Queued for up to
# 24 h. Say so up front. ({owner}/{repo} is filled in by gh from the git remote.)
runner=$(gh api 'repos/{owner}/{repo}/actions/runners' \
  -q '[.runners[] | select(any(.labels[]; .name == "minikube")) | .status] | first // "missing"' \
  2>/dev/null || echo "unknown")
if [[ "$runner" != "online" ]]; then
  echo "! the minikube runner is $runner: jobs will wait in Queued (docs/ci-cd.md, Troubleshooting)"
fi

rc=0
gh run watch "$run_id" --interval 30 --exit-status || rc=$?

echo
echo "==> Jobs"
gh run view "$run_id" --json jobs -q '.jobs[] | "    \(.conclusion // .status)\t\(.name)"'
echo "==> Disk on this machine: $(df -h / | awk 'NR == 2 { print $4 }') free (keep ≥ 10G)"

if (( rc != 0 )); then
  echo "✘ Deploy didn't succeed. Logs: gh run view $run_id --log-failed"
  echo "  A job cancelled by \"The runner has received a shutdown signal\" is the runner"
  echo "  restarting, not the code. Re-run it: gh run rerun $run_id --failed"
  exit "$rc"
fi
echo "✔ Deploy succeeded"
