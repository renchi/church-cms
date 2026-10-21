---
name: ship
description: Ship a verified, reviewed ticket branch — check disk, push, open the PR from the template, watch CI in the background, merge only after the user says so, watch Deploy in the background, mark the Linear ticket Done, and capture lessons. Use after /verify and /code-review.
argument-hint: "[CMS-<n>]  (omit to read it from the branch name)"
disable-model-invocation: true
---

# Ship a ticket

Runs the PR → CI → Merge → Done rows of the CLAUDE.md Workflow table, and starts the Deploy watch. Stop and tell the user if any step fails. **Never merge without the user's explicit go-ahead in this session.**

**Keep the chat free.** The two long waits (CI and Deploy) run as background Bash commands (`run_in_background`) through `scripts/agent-status.sh run`, which records each one's result in the ticket's status record. Start one, tell the user in a line, and end the turn; the completion notification brings you back. Meanwhile the user can ask anything, and `/status` answers from the record (study-guide §12.4). After the merge you're on `main`, so pass `--ticket CMS-<n>` (for a branch without a ticket, its name with `/` as `-`, e.g. `chore-<slug>`). Those `--ticket` calls, and the `run deploy` one, ask the user for permission: that's deliberate (study-guide §12.4).

## 1. Preconditions

- On a `cms-<n>/…` (or `chore/…`) branch, never `main`. The ticket number comes from the argument or the branch name.
- **No ticket** (a `chore/…` branch and no argument): leave `CMS-<n>` out of the PR title and body, and skip the Linear step in 7. Never guess a ticket number.
- `git status --short` is clean and every commit is in.
- This session has a `/verify` report with no failed step, and the `/code-review` findings are fixed. If either is missing, say so and stop. Don't run them yourself here.

## 2. Disk (the self-hosted runner builds on this machine)

```bash
df -h /     # Avail should be ≥ 10G. A Deploy that rebuilds all three images needs ~8 GB
```

If less than ~10 GB is free, tell the user before pushing and offer the cleanup. Two things fill the disk: build cache, and old deploy images (about 0.3 GB per service per deploy since CMS-33, 1.3 GB before; on the host and inside minikube). `scripts/prune-deploy-images.sh <release> <image>` removes the second kind, keeping the tags Helm deployed most recently (read from `helm history`, so it's right even after `/verify` deployed `local-*` builds). Deploy runs it after every upgrade, so leftovers come from older deploys or interrupted runs.

```bash
DRY_RUN=1 scripts/prune-deploy-images.sh web ghcr.io/renchi/church-cms/web   # optional: see what would go first
docker builder prune -af
for s in members-service events-service web; do scripts/prune-deploy-images.sh "$s" "ghcr.io/renchi/church-cms/$s"; done
if env=$(minikube docker-env); then        # not `eval "$(…)"`: a failure there would hit the host twice
  eval "$env"
  docker builder prune -af
  for s in members-service events-service web; do scripts/prune-deploy-images.sh "$s" "ghcr.io/renchi/church-cms/$s"; done
  for p in members-service:members-service events-service:events-service web:church-cms-web; do
    scripts/prune-deploy-images.sh "${p%%:*}" "${p#*:}"     # local-* builds from /verify
  done
  eval "$(minikube docker-env -u)"
else
  echo "minikube unreachable: its images were NOT cleaned"   # tell the user; don't report the disk as fixed
fi
```

The script fails closed: if Helm or Docker doesn't answer it removes nothing and exits non-zero, so treat any non-zero exit as "not cleaned".

Never use `docker image prune -a` on the host: minikube runs on an untagged `kicbase` image, which it deletes.

A change to `pnpm-lock.yaml` or another shared file redeploys **every** service. Say so when the diff has one.

## 3. Push and open the PR

```bash
git push -u origin "$(git branch --show-current)"
gh pr create --title "<type>(<scope>): <summary> (CMS-<n>)" --body-file <filled template>
```

Fill `.github/pull_request_template.md`: the ticket, a short what/why, the `/verify` table as it was reported (don't upgrade a "skipped" to a "pass"), the learning-deliverables checklist ticked only for what exists, and the deploy impact (`git diff --name-only main...HEAD` → which `apps/<svc>/` or `charts/<svc>/` changed). End the body with the attribution line from the system reminder.

Then record the PR: `scripts/agent-status.sh pr <n>`.

## 4. CI (in the background)

Start it with `run_in_background`, then end the turn:

```bash
scripts/agent-status.sh run ci -- gh pr checks --watch   # lint-typecheck, unit-tests, integration-tests: required by branch protection
```

When the notification arrives, read the task's output for the per-check results.

- A real failure: fix it on the branch, push, and start the watch again.
- Jobs "not acquired by Runner" / cancelled with no failing step is a GitHub outage, not a test failure: `gh run rerun <run-id> --failed`.

## 5. Merge (the user decides)

Record that it's waiting on the user, then notify them (PushNotification, if available: "CI green on PR #<n>: merge?"), since they may have moved on to something else:

```bash
scripts/agent-status.sh set merge waiting "CI green on PR #<n>"
```

Show the PR URL and the green checks, and ask: "Merge PR #<n>?" Only on a clear yes:

```bash
gh pr merge <n> --merge --delete-branch     # merge commits, like every PR so far
git checkout main && git pull
scripts/agent-status.sh --ticket CMS-<n> set merge done "PR #<n> merged"   # on main now, so name the ticket
```

## 6. Deploy (in the background; don't wait for it)

Deploy starts by itself when CI passes on `main` (`workflow_run`), so there's nothing to trigger. A cold build of every image takes a while, so it never holds up step 7. Start the watch with `run_in_background`, with the merge commit:

```bash
scripts/agent-status.sh --ticket CMS-<n> run deploy -- scripts/watch-deploy.sh <merge-sha>   # waits for the run, watches it, prints job results + free disk
```

Tell the user which services will redeploy (step 2's note on shared files applies), and that they can also run `scripts/watch-deploy.sh <merge-sha>` in their own terminal to watch it live. Go on to step 7 without waiting. When the notification arrives, report the result in a line.

On a failure, read it with `gh run view <run-id> --log-failed` and fix it on a new branch. A job cancelled by "The runner has received a shutdown signal" is a runner restart, not the code: `gh run rerun <run-id> --failed`.

## 7. Close the loop

- Move the Linear ticket to **Done** (`save_issue` with the Done state), then `scripts/agent-status.sh --ticket CMS-<n> set done done`. Skip the Linear part when there's no ticket.
- Check `docs/study-guide.md`'s "What setting it up taught" table for the problems that actually came up this ticket. If one is missing, say so (that's a follow-up docs PR, not a direct edit to main).
- Save to memory only what isn't in the repo and would save a future session time (a new operational gotcha, a decision the user made). Update an existing memory instead of adding a near-duplicate.
- Suggest `/mattpocock-skills:retro` (a retrospective on the session), in one line. Its findings feed the study guide's "What setting it up taught" table. Don't run it yourself.
- Point out the next ticket at the top of `Todo`, if there is one.
