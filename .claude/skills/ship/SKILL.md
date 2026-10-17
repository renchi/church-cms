---
name: ship
description: Ship a verified, reviewed ticket branch — check disk, push, open the PR from the template, watch CI, merge only after the user says so, watch the Deploy run, mark the Linear ticket Done, and capture lessons. Use after /verify and /code-review.
argument-hint: "[CMS-<n>]  (omit to read it from the branch name)"
disable-model-invocation: true
---

# Ship a ticket

Runs the PR → CI → Merge → Deploy → Done rows of the CLAUDE.md Workflow table. Stop and tell the user if any step fails. **Never merge without the user's explicit go-ahead in this session.**

## 1. Preconditions

- On a `cms-<n>/…` (or `chore/…`) branch, never `main`. The ticket number comes from the argument or the branch name.
- **No ticket** (a `chore/…` branch and no argument): leave `CMS-<n>` out of the PR title and body, and skip the Linear step in 7. Never guess a ticket number.
- `git status --short` is clean and every commit is in.
- This session has a `/verify` report with no failed step, and the `/code-review` findings are fixed. If either is missing, say so and stop. Don't run them yourself here.

## 2. Disk (the self-hosted runner builds on this machine)

```bash
df -h /     # Avail should be ≥ 10G. A Deploy that rebuilds all three images needs ~8 GB
```

If less than ~10 GB is free, tell the user before pushing and offer the cleanup. Two things fill the disk: build cache, and old deploy images (about 1.3 GB per service per deploy, on the host and inside minikube). `scripts/prune-deploy-images.sh <release> <image>` removes the second kind, keeping the tags Helm deployed most recently (read from `helm history`, so it's right even after `/verify` deployed `local-*` builds). Deploy runs it after every upgrade, so leftovers come from older deploys or interrupted runs.

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

## 4. CI

```bash
gh pr checks --watch     # lint-typecheck, unit-tests and integration-tests are required by branch protection
```

- A real failure: fix it on the branch, push, and watch again.
- Jobs "not acquired by Runner" / cancelled with no failing step is a GitHub outage, not a test failure: `gh run rerun <run-id> --failed`.

## 5. Merge (the user decides)

Show the PR URL and the green checks, and ask: "Merge PR #<n>?" Only on a clear yes:

```bash
gh pr merge <n> --merge --delete-branch     # merge commits, like every PR so far
git checkout main && git pull
```

## 6. Deploy

Deploy starts when CI finishes on `main` (`workflow_run`), so give it a few minutes to appear. Filter by the merge commit: the latest Deploy run may be an older one, and watching that would report success for a deploy that hasn't run yet.

```bash
sha=$(git rev-parse HEAD)                   # the merge commit, after the pull in step 5
gh run list --workflow=Deploy --commit "$sha" --json databaseId,status   # repeat until it lists a run
gh run watch <run-id> --exit-status
```

If a job fails before any step runs, check `df -h /` first (see step 2). Then report which services were deployed, how long it took, and the free disk afterwards: the `cleanup` job writes it to the run summary (`gh run view <run-id>`), or run `df -h /`. Below ~10 GB, say so before the next ticket starts.

## 7. Close the loop

- Move the Linear ticket to **Done** (`save_issue` with the Done state). Skip this when there's no ticket.
- Check `docs/study-guide.md`'s "What setting it up taught" table for the problems that actually came up this ticket. If one is missing, say so (that's a follow-up docs PR, not a direct edit to main).
- Save to memory only what isn't in the repo and would save a future session time (a new operational gotcha, a decision the user made). Update an existing memory instead of adding a near-duplicate.
- Suggest `/mattpocock-skills:retro` (a retrospective on the session), in one line. Its findings feed the study guide's "What setting it up taught" table. Don't run it yourself.
- Point out the next ticket at the top of `Todo`, if there is one.
