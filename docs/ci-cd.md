# CI/CD Pipeline

Two GitHub Actions workflows automate checking and shipping the code:

| Workflow | File | Trigger | Runs on | Does |
|---|---|---|---|---|
| **CI** | [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) | every PR to `main` (and pushes to `main`) | GitHub-hosted `ubuntu-latest` | lint, typecheck, build, unit tests, integration tests |
| **Deploy** | [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) | CI **passing** on `main` (i.e. after a merge), or manual | **self-hosted** runner on the minikube machine | build image → push to ghcr.io → `helm upgrade` into minikube |

```
 PR opened / updated                         Merge to main → CI passes on main
        │                                          │  (workflow_run)
        ▼                                          ▼
 ┌──────────────── CI (GitHub cloud) ───┐   ┌── Deploy ─────────────────────────────────┐
 │ lint-typecheck   unit-tests          │   │ changes (cloud): which services changed?  │
 │ integration-tests (Testcontainers)   │   │            │                              │
 └──────────────┬───────────────────────┘   │            ▼  one job per changed service │
                │ all green?                │ deploy (self-hosted, this machine):       │
                ▼                           │   docker build  → ghcr.io/…/<svc>:<sha>   │
   branch protection allows merge           │   docker push                             │
                                            │   helm upgrade --rollback-on-failure      │
                                            │     └─ init container: prisma migrate     │
                                            └───────────────────────────────────────────┘
```

---

## Why a self-hosted runner?

minikube runs on a developer machine (Docker driver, private IP `192.168.49.2`). GitHub's cloud runners cannot reach that API server, so a kubeconfig stored as a GitHub secret would be useless.

Instead, a **runner is registered on the same machine**. It polls GitHub for jobs (outbound HTTPS only, so nothing is exposed to the internet). It uses the machine's Docker daemon and `~/.kube/config` directly. The machine is arm64, so images are built natively for minikube's arm64 node.

**The deploy only happens while this machine is on and the runner is running.** If it's off, the Deploy run waits in the queue and starts as soon as the runner comes back (or fails after 24 h).

**Security:** the repo is public, so `deploy.yml` deliberately has **no `pull_request` trigger**. Only code already merged to `main` ever runs on this machine. CI (which does run PR code) uses GitHub's cloud runners only.

---

## One-time setup

### 1. Register the self-hosted runner

Prerequisites on the machine, for the user the runner will run as:

```bash
docker ps                 # works without sudo (user is in the "docker" group)
kubectl get nodes         # ~/.kube/config points at minikube
helm version              # v4.x on PATH (deploy uses --rollback-on-failure, a Helm 4 flag)
```

Then on GitHub, go to **Settings → Actions → Runners → New self-hosted runner**, choose **Linux / ARM64**, and run the commands it shows (download, extract, `./config.sh …`). When `config.sh` asks for extra labels, enter:

```
minikube
```

`deploy.yml` targets `runs-on: [self-hosted, linux, ARM64, minikube]`. GitHub adds the first three labels automatically, and `minikube` picks out this runner specifically.

Install it as a service so it starts on boot:

```bash
cd ~/actions-runner
sudo ./svc.sh install $USER   # run the service as you, so it sees your docker group + kubeconfig
sudo ./svc.sh start
sudo ./svc.sh status
```

> The service captures your `PATH` at install time (`~/actions-runner/.path`). If `helm` or `kubectl` are installed later or in a new location, run `./env.sh` again and restart the service.

### 2. Branch protection (makes "failed tests block the merge" real)

After CI has run at least once (so the check names exist):

```bash
gh api -X PUT repos/renchi/church-cms/branches/main/protection --input - <<'EOF'
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["lint-typecheck", "unit-tests", "integration-tests"]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": null,
  "restrictions": null
}
EOF
```

- `strict: true` means the PR must be up to date with `main` before it can merge.
- `enforce_admins: true` means the repo owner can't bypass it either.

### 3. Make the container images public (once, after the first deploy)

The first push of each service creates its package: `ghcr.io/renchi/church-cms/members-service`, `.../events-service` and `.../web`. minikube pulls them without credentials, so they must be public. **This repeats for every new service:** its first Deploy fails with `ImagePullBackOff` (Helm rolls back) until you make its package public and re-run the job with `gh run rerun <id> --failed`. For each package, go to GitHub → your profile → **Packages** → package → **Package settings** → **Change visibility** → Public.

(The alternative is an `imagePullSecret` in the cluster. Public images are simpler, and the repo is public anyway.)

### 4. Start minikube

The runner deploys into whatever `kubectl` points at, so minikube must be running (`minikube start`). The runner service starts by itself at boot, but **minikube does not**: after a reboot, run `minikube start` again. Postgres, Traefik and the monitoring stack must be installed too: run `scripts/cluster-up.sh` once (see [k8s-local-dev.md](k8s-local-dev.md)).

---

## Day-to-day

All the places to watch the pipeline and cluster (URLs, dashboards, commands) are collected in [status-dashboards.md](status-dashboards.md).

| I want to… | Do |
|---|---|
| See CI on my PR | `gh pr checks --watch` |
| Watch a deploy | `gh run watch` (or the **Actions** tab) |
| Redeploy everything without a code change | `gh workflow run deploy.yml` |
| See what image is running | `kubectl get deploy -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{..image}{"\n"}{end}'` |
| See migration output | `kubectl logs <members-pod> -c migrate` (same for an events-service Pod) |
| Roll back | `helm rollback <release>` (or revert the commit; the next deploy ships the old code) |

Only services whose files changed are rebuilt:

- `apps/<svc>/**` and `charts/<svc>/**` trigger that service only.
- Shared files (`pnpm-lock.yaml`, `package.json`, `tsconfig.base.json`, `packages/**`, the workflow itself) trigger every service.
- A manual run always deploys every service (members-service, events-service, web).

Every image is tagged with the **commit SHA**, plus a moving `main` tag. The SHA tag makes it obvious which commit is running and makes every deploy a real change that Kubernetes rolls out.

Unique tags also mean unique images, about 1.3 GB per service per deploy, stored twice: on the host, where the runner builds, and inside minikube, which pulls from ghcr.io. The job's **Remove superseded images** step runs [`scripts/prune-deploy-images.sh`](../scripts/prune-deploy-images.sh) in both places after a successful upgrade. It keeps the current tag, the previous one (the rollback target) and `main`, and clears build cache older than 24 h. Its last line is `df -h /`, so every deploy log shows the free disk:

```
# ghcr.io/renchi/church-cms/web: keeping <this sha> and <previous sha> (rollback target)
#   removed ghcr.io/renchi/church-cms/web:<an older sha>      ← one line per removed tag, if any
# (the same again for minikube's Docker)
# /dev/sda2        62G   44G   16G  73% /                       ← should stay ≥ 10G
```

### Shipping a ticket with `/ship`

After `/verify` and `/code-review`, the agent's `/ship` skill ([`.claude/skills/ship/SKILL.md`](../.claude/skills/ship/SKILL.md)) runs the rest of this section in order. The same steps work by hand:

```bash
df -h /                                    # 1. Avail ≥ 10G, or the Deploy build can die mid-way
# /dev/sda2   62G   49G   11G  83% /
git push -u origin "$(git branch --show-current)"
gh pr create                               # 2. the body starts from .github/pull_request_template.md
gh pr checks --watch                       # 3. waits for the three required checks
# lint-typecheck      pass  1m10s
# unit-tests          pass  40s
# integration-tests   pass  1m50s
gh pr merge <n> --merge --delete-branch    # 4. YOU decide this; the agent asks first
gh run list --workflow=Deploy --limit 1    # 5. appears ~1 min after the merge, once CI passes on main
gh run watch <run-id> --exit-status        #    exits non-zero if any service failed to deploy
```

Then mark the ticket Done in Linear.

**What this does:** each step is a gate the next one depends on. The disk check comes *first* because a full disk fails the Deploy build after the merge, when the PR is already on `main`. The merge is the one step the agent never auto-runs: `gh pr merge` isn't in `.claude/settings.json`'s allowlist, so Claude Code asks you even if the skill forgot to (study-guide §12.3).

### Migrations and rollbacks (expand/contract)

Each service's `migrate` init container (members-service and events-service) applies migrations **before** the new Pods are known to be healthy. If they then fail readiness, `helm --rollback-on-failure` rolls back the image, but **not the schema**. The old code then runs against the new schema.

So every migration must work with **both** the old and new code:

| Change | Release N (expand) | Release N+1 (contract) |
|---|---|---|
| Add a column | add it nullable / with a default | make it required, if needed |
| Rename a column | add new column, write to both, backfill | read from new, drop old |
| Drop a column | stop reading/writing it in code | drop it |

A real example: events-service's second migration
([`20261010150000_service_event_version`](../apps/events-service/prisma/migrations/20261010150000_service_event_version/migration.sql))
adds `version` **with a default**, so the previous release, which doesn't know the
column, can still insert rows. The default also had to suit rows that *already exist*:
`0` broke editing them, `1` didn't (study-guide §10.4).

### Adding a new service to the pipeline

What CMS-18 needed for events-service, in order:

1. `deploy.yml`: a paths-filter entry and a place in the manual-run list. `ci.yml`: its `prisma generate` and `test:coverage` steps.
2. **Its database in the cluster before the first merge.** Deploy only runs Helm; it never applies `k8s/*.yaml`. Without `events-postgres`, the `migrate` init container can't connect, `--wait` times out and the release fails. `scripts/cluster-up.sh` applies it.
3. After the first Deploy: make the new GHCR package public (setup step 3) and re-run the job.

---

## Debugging

| Symptom | Likely cause / fix |
|---|---|
| Deploy job stuck in "Queued" | Runner offline: `sudo ~/actions-runner/svc.sh status`, then `start` |
| A Deploy job fails before any step runs, or `no space left on device` | Disk full. `df -h /`, then `docker system df` on the host and after `eval "$(minikube docker-env)"`. Old `<sha>` images: `scripts/prune-deploy-images.sh <image> <running-tag>` (the `/ship` skill, step 2, has the loop). Build cache: `docker builder prune -af`. Never `docker image prune -a` on the host: it deletes the untagged `kicbase` image minikube runs on |
| `docker: permission denied` in runner | Runner user not in `docker` group: `sudo usermod -aG docker $USER`, then restart the service |
| `kubernetes cluster unreachable` | minikube stopped: `minikube start` |
| `helm: command not found` | Runner PATH is stale; see the note in setup step 1 |
| Pods `ImagePullBackOff` | GHCR package still private (setup step 3; happens once per new service), or the push failed |
| New service's deploy times out, `migrate` init container keeps restarting | Its Postgres isn't in the cluster: `kubectl get deploy <svc>-postgres`. Run `scripts/cluster-up.sh` ("Adding a new service" above) |
| Helm "UPGRADE FAILED … rolled back" | New Pods never became Ready. Check `kubectl describe pod` and `kubectl logs <pod> -c migrate` |
| `denied: permission_denied` on push | Package not linked to the repo. In package settings → **Manage Actions access**, add `church-cms` with write access |
| CI `integration-tests` fails, others pass | Testcontainers couldn't start Postgres. Check the job log for Docker errors |
| CI jobs **cancelled** with "The job was not acquired by Runner of type hosted" | A GitHub Actions outage (check <https://www.githubstatus.com>), not a test failure. Re-run once it recovers: `gh run rerun <id> --failed` |
| `failed to run git: not a git repository` from `gh` | The terminal isn't inside the repo. `cd ~/church-cms`, or add `-R renchi/church-cms` |
| CI `lint-typecheck` fails at `scripts/check-docs.sh` | A doc link points at a missing file or past the end of one. The `✘` line names the doc, its line and the target. Run `scripts/check-docs.sh` locally, fix the link and push |

---

## Exercises: the docs gate

**1. Break a line link on purpose.** On a scratch branch, change a line anchor in
`docs/events-service-ddd.md` so it no longer matches its label, and point another one at
a file that doesn't exist:

```bash
git checkout -b scratch/docs-gate
sed -i 's|RecordAttendanceUseCase.ts#L29)|RecordAttendanceUseCase.ts#L31)|' docs/events-service-ddd.md
sed -i 's|prisma/schema.prisma#L65)|prisma/nope.prisma#L65)|' docs/events-service-ddd.md
scripts/check-docs.sh; echo "exit=$?"
# ✘ docs/events-service-ddd.md:84 → label says line 29 but the link goes to #L31
# ✘ docs/events-service-ddd.md:87 → ../apps/events-service/prisma/nope.prisma#L65: apps/events-service/prisma/nope.prisma does not exist
# 2 error(s), 0 warning(s)
# exit=1
```

Push it and open a draft PR (`gh pr create --draft`) to watch the `lint-typecheck` job
go red at the same step. Then clean up: `gh pr close --delete-branch`, `git checkout main`,
`git branch -D scratch/docs-gate`.

**2. The warning a script can't decide.** Add a blank line at the top of
`apps/events-service/src/domain/Attendance.ts` (don't commit) and run the check again:

```bash
scripts/check-docs.sh
# ! docs/events-service-ddd.md:74 → ../apps/events-service/src/domain/Attendance.ts#L52: apps/events-service/src/domain/Attendance.ts changed on this branch; is line 52 still the right one?
# ! docs/study-guide.md:856 → …Attendance.ts#L65: … changed on this branch; is line 65 still the right one?
# (the doc line numbers before the → move as the docs grow; the targets after it are what matter)
```

Every line below the blank one moved down by one, so both links are now off by one, yet
both files still exist and are long enough. The script can't tell whether a link is
*right*, only that it *might* have moved, so it warns and leaves the decision to you.
That's the split this whole workflow uses: mechanical checks for what a machine can
decide, review for the rest. Undo with `git checkout -- apps/events-service/src/domain/Attendance.ts`.

## Exercise: the image cleanup

What Deploy's **Remove superseded images** step does, on images you can afford to lose.
Run it in **bash** (in zsh, `$I:fakeold1` is read as a `:f` modifier). The fake tags are
extra names for the running image, so nothing real is deleted.

```bash
bash
I=ghcr.io/renchi/church-cms/web
T=$(kubectl get deploy web-web -o jsonpath='{.spec.template.spec.containers[0].image}' | sed 's/.*://')
docker tag "$I:$T" "$I:fakeold1"; sleep 1; docker tag "$I:$T" "$I:fakeold2"
scripts/prune-deploy-images.sh "$I" "$T"
# ghcr.io/renchi/church-cms/web: keeping <running sha> and fakeold2 (rollback target)
#   removed ghcr.io/renchi/church-cms/web:fakeold1
docker images "$I" --format '{{.Tag}}' | sort
# <running sha>
# fakeold2           ← kept: the newest older tag is what `helm rollback` would need
# main               ← kept: the moving tag
scripts/prune-deploy-images.sh "$I" "$T"
# ghcr.io/renchi/church-cms/web: nothing to remove (keeping <running sha> and fakeold2)
docker image rm "$I:fakeold2"; exit
```

Expected: the second run removes nothing. The script only ever looks at one repository's
tags, which is why it's safe next to minikube's untagged `kicbase` image, where
`docker image prune -a` is not. Then ask yourself: if a deploy *failed*, why is it right
that this step doesn't run? (Answer: Helm rolled back to the previous image, and that's
exactly the one a cleanup would be tempted to remove.)

