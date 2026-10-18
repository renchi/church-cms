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

The runner deploys into whatever `kubectl` points at, so minikube must be running (`minikube start`). The runner service starts by itself at boot, but **minikube does not** (its container's restart policy is `no`). Each Deploy job therefore starts with **Make sure minikube is running** (`minikube status || minikube start`), which brings the existing cluster back with its data. See [After a reboot](#after-a-reboot). Postgres, Traefik and the monitoring stack must be installed too: run `scripts/cluster-up.sh` once (see [k8s-local-dev.md](k8s-local-dev.md)).

---

## Day-to-day

All the places to watch the pipeline and cluster (URLs, dashboards, commands) are collected in [status-dashboards.md](status-dashboards.md).

| I want to… | Do |
|---|---|
| See CI on my PR | `gh pr checks --watch` |
| Watch a deploy | `scripts/watch-deploy.sh` (or the **Actions** tab). `/ship` hands you this after the merge instead of waiting on Deploy itself |
| Redeploy everything without a code change | `gh workflow run deploy.yml` |
| See what image is running | `kubectl get deploy -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{..image}{"\n"}{end}'` |
| See migration output | `kubectl logs <members-pod> -c migrate` (same for an events-service Pod) |
| Roll back | `helm rollback <release>` (or revert the commit; the next deploy ships the old code) |

Only services whose files changed are rebuilt:

- `apps/<svc>/**` and `charts/<svc>/**` trigger that service only.
- Shared files (`pnpm-lock.yaml`, `package.json`, `tsconfig.base.json`, `packages/**`, the workflow itself) trigger every service.
- A manual run always deploys every service (members-service, events-service, web).

Every image is tagged with the **commit SHA**, plus a moving `main` tag. The SHA tag makes it obvious which commit is running and makes every deploy a real change that Kubernetes rolls out.

Unique tags also mean unique images, about 0.3 GB per service per deploy (1.3 GB before CMS-33 slimmed them; see [Where the runner's disk goes](#where-the-runners-disk-goes)), stored twice: on the host, where the runner builds, and inside minikube, which pulls from ghcr.io. After a successful upgrade, each deploy job's **Remove superseded images** step runs [`scripts/prune-deploy-images.sh`](../scripts/prune-deploy-images.sh) in both places.

Which tags it keeps comes from **`helm history`**, not from image dates: the images used by the release's newest two successful revisions (what's running, and what `helm rollback` would go back to), plus `main`. Failed revisions don't count. Image build times can't answer "what was deployed when": a rebuild that hits the cache keeps the old creation time. It only ever removes *deploy tags* (a commit SHA, or `local-…` from `cluster-up.sh`), so a hand-made `:debug` tag survives. And it **fails closed**: if Helm or Docker doesn't answer, it removes nothing and exits non-zero. Inside minikube it also clears the `local-*` builds `/verify` left behind, by the same rule: a `/verify` build that was the revision just before this deploy stays (it's what `helm rollback` goes back to, and with `pullPolicy=Never` it can't be pulled), and goes one deploy later. A removed ghcr image is never lost: it's still in the registry, and a rollback pulls it again.

The step has `continue-on-error`, so a cleanup problem shows as a warning instead of failing a deploy whose Pods are already healthy. A final **cleanup** job then caps the build cache at 1 GB per daemon with [`scripts/prune-build-cache.sh`](../scripts/prune-build-cache.sh) (`docker builder prune --max-used-space`, which keeps the most recently used layers; the cap is defined only there), once for the whole deploy, and writes what it reclaimed and the free disk to the run summary. It prunes in passes until one frees nothing, because a cache record holds its parent and one pass only removes the outermost records. The cap counts only cache that can be freed: `docker system df`'s "Build Cache" size also includes layers that images use, which no prune can free, so it can read above 1 GB. Compare its RECLAIMABLE column with the cap. (Until CMS-33 the cap was 3 GB and never fired: the images used almost all the cache, so almost nothing was reclaimable.) A *size* cap, because an age limit doesn't bound anything: on one busy day of `/verify` runs and deploys, ~11 GB of same-day cache took the disk to 6.8 GB under the earlier "older than 24 h" rule.

```
# deploy (web) › Remove superseded images
#   removed ghcr.io/renchi/church-cms/web:<an older sha>      ← one line per removed tag, if any
# ghcr.io/renchi/church-cms/web: kept <this sha> <previous sha> (newest 2 revision(s) of 'web'), removed 1
# (then the same inside minikube, for ghcr.io/… and for church-cms-web's local-* builds)
# cleanup › Prune build cache and report disk
# Build cache: host Total: 0.9GB + 0B · minikube Total: 1.4GB + 0.3GB + 0B · free disk 17G      ← keep ≥ 10G
#              (one amount per prune pass; the last pass freeing 0B is what ends the loop)
```

`scripts/cluster-up.sh` uses the same script for its `local-*` builds, keeping only the one it just deployed, and caps minikube's build cache the same way. To see what a run would remove without removing anything, prefix it with `DRY_RUN=1`.

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

## Where the runner's disk goes

The runner shares a 62 GB disk with minikube, swap, the OS and your editor. Keep ≥ 10 GB free. When it drops, find out *where* before deleting anything. The method from CMS-33 needs no root:

```bash
df -h /                                  # 1. the total
# /dev/sda2   62G   52G  7.3G  88% /
du -xsh /usr /var /home /boot /swap.img 2>/dev/null   # 2. what you can read
# 5.8G /usr · 4.5G /var · 8.3G /home · 307M /boot · 3.9G /swap.img   ← swap counts too
docker system df                         # 3. what the host's Docker reports
eval "$(minikube docker-env)"; docker system df; eval "$(minikube docker-env -u)"   # 4. minikube's
minikube ssh -- df -h /var               # 5. minikube's /var IS the host disk
# /dev/sda2   62G   52G  7.3G  88% /var  ← same device: deleting inside minikube frees host disk
```

Subtract 2 and 3 from 1. What's left lives in folders only root can read (`/var/lib/docker`, `/var/lib/containerd`): `sudo du -sh /var/lib/docker/* /var/lib/containerd/*` shows it.

Then ask *which layer* is big and *how many copies* exist:

```bash
docker history <image> --format '{{.Size}}\t{{.CreatedBy}}' | sort -h | tail -3   # the biggest layers
docker image ls --tree          # DISK USAGE (unpacked) vs CONTENT SIZE (compressed), containerd store
docker buildx du | tail -4      # Shared = cache bytes an image also uses: pruning them frees 0 B
```

What CMS-33 found, as a reference point: each app image was 1.3 GB, 836 MB of it a single `COPY /repo/node_modules` layer, and it existed three times (host build, minikube's ghcr copy, minikube's `local-*` rollback build). After slimming, the images are ~0.3 GB and the disk sat at 17 GB free. The full story is in [study-guide §2.5](study-guide.md#25-whats-inside-an-image-and-where-it-lives-on-disk-cms-33).

### After a reboot

The runner is a systemd service and comes back by itself. minikube doesn't: `docker inspect minikube --format '{{.HostConfig.RestartPolicy.Name}}'` prints `no`. Nothing breaks until the next Deploy, which starts it in its first step:

```
# deploy (web) › Make sure minikube is running
# * Restarting existing docker container for "minikube" ...
# * Done! kubectl is now configured to use "minikube" cluster ...
```

To bring it back by hand (for `kubectl`, Grafana, `/verify`): `minikube start`, or `scripts/cluster-up.sh --no-sudo`, which also re-checks the tunnel and `/etc/hosts`. `minikube tunnel` is not restarted by either: run it again in its own terminal if `cms.local` doesn't answer.

---

## Debugging

| Symptom | Likely cause / fix |
|---|---|
| Deploy job stuck in "Queued" | Runner offline: `sudo ~/actions-runner/svc.sh status`, then `start`. If the service stops again by itself, read why: `journalctl -u 'actions.runner.*' -n 20` (next two rows) |
| Runner log: "The runner registration has been deleted from the server" | Often **not** true. Read the detail in `~/actions-runner/_diag/Runner_*.log` (newest): `The token expired on … Current server time is …` means this machine's clock is wrong, so every login token it signs is already expired. `timedatectl` → `System clock synchronized: no`, `NTP service: inactive`. Fix: `sudo timedatectl set-ntp true`, then restart the runner service. Only if the log has no clock error, re-register: `./config.sh remove --token $(gh api -X POST 'repos/{owner}/{repo}/actions/runners/remove-token' -q .token)`, then `./config.sh` again (setup step 4) |
| A Deploy job cancelled: "The runner has received a shutdown signal" | The runner service was stopped or restarted mid-job, not a code problem. When the run has finished: `gh run rerun <run-id> --failed` |
| A Deploy job fails before any step runs, or `no space left on device` | Disk full. `df -h /`, then `docker system df` on the host and after `eval "$(minikube docker-env)"`. Old deploy images: `scripts/prune-deploy-images.sh <release> <image>`, once on the host and once after `eval "$(minikube docker-env)"` (the `/ship` skill, step 2, has the loop). Build cache: `docker builder prune -af`. Never `docker image prune -a` on the host: it deletes the untagged `kicbase` image minikube runs on |
| `docker: permission denied` in runner | Runner user not in `docker` group: `sudo usermod -aG docker $USER`, then restart the service |
| `kubernetes cluster unreachable` | minikube stopped (after a reboot, usually): `minikube start`. Deploy does this itself since CMS-33; see [After a reboot](#after-a-reboot) |
| `/verify` or `cluster-up.sh` hangs, a new Pod shows `Init:ErrImageNeverPull` right after a successful build | Something deleted the fresh `local-*` image. `docker events --since 30m --filter type=image` (after `eval "$(minikube docker-env)"`) shows who: a delete seconds after the build means another `cluster-up.sh` (another terminal or agent session) ran its cleanup at the same time. Run one at a time, then re-run |
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

**2. A moved line, and a changed one.** Add a blank line at the top of
`apps/events-service/src/domain/Attendance.ts` (don't commit) and run the check again:

```bash
sed -i '1i\\' apps/events-service/src/domain/Attendance.ts
scripts/check-docs.sh; echo "exit=$?"
# ✘ docs/events-service-ddd.md:74 → ../apps/events-service/src/domain/Attendance.ts#L52: the line it pointed at moved to L53 (static record()
# ✘ docs/study-guide.md:947 → ../apps/events-service/src/domain/Attendance.ts#L65: the line it pointed at moved to L66 (if (!event.isOpenForCheckIn()) {)
# 2 error(s), 1 warning(s)
# exit=1
# (the doc line numbers before the → move as the docs grow; the targets after it are what matter)
```

Every line below the blank one moved down by one. The script compares each link's target
line on `main` with this branch: the same text now sits one line lower, so the link is
wrong, and it says where to point it. Now undo that, and instead *rename* the method on the
linked line:

```bash
git checkout -- apps/events-service/src/domain/Attendance.ts
sed -i '52s/static record(/static checkIn(/' apps/events-service/src/domain/Attendance.ts
scripts/check-docs.sh
# ! docs/events-service-ddd.md:74 → ../apps/events-service/src/domain/Attendance.ts#L52: line 52 changed. Was: static record( · Now: static checkIn(
# ✔ docs OK (2 warning(s))
```

The line is still at L52 but says something else. Is the doc's sentence about it still
true? Only a reader can tell, so this one stays a warning, with both versions printed so
you don't have to open the file. That's the split this whole workflow uses: mechanical
checks for what a machine can decide, review for the rest. Undo with
`git checkout -- apps/events-service/src/domain/Attendance.ts`.

## Exercise: the image cleanup

Predict what Deploy's **Remove superseded images** step would remove, then check. Every
command here is read-only: `DRY_RUN=1` makes the script print "would remove" and stop.

```bash
helm history web --max 3            # REVISION, STATUS (deployed / superseded / failed), DESCRIPTION
for r in $(helm history web --max 3 -o json | jq -r '.[].revision'); do
  echo "$r $(helm get values web --revision "$r" --all -o json | jq -c '{r: .image.repository, t: .image.tag}')"
done
# 35 {"r":"ghcr.io/renchi/church-cms/web","t":"<sha>"}      ← a CI deploy
# 36 {"r":"church-cms-web","t":"local-…"}                  ← a cluster-up.sh (/verify) build
# 37 {"r":"church-cms-web","t":"local-…"}                  ← re-run, same build: same tag
```

Write down which images the newest two revisions use. Then:

```bash
DRY_RUN=1 scripts/prune-deploy-images.sh web ghcr.io/renchi/church-cms/web
eval "$(minikube docker-env)"
DRY_RUN=1 scripts/prune-deploy-images.sh web ghcr.io/renchi/church-cms/web
DRY_RUN=1 scripts/prune-deploy-images.sh web church-cms-web
eval "$(minikube docker-env -u)"
#   would remove …:<tag>          ← only tags outside the newest two revisions
# …: kept <tags> (newest 2 revision(s) of 'web'), would remove N
DRY_RUN=1 scripts/prune-deploy-images.sh nope ghcr.io/renchi/church-cms/web; echo "exit=$?"
# Error: release: not found
# exit=1                          ← fails closed: no history, nothing removed
```

Expected: the "kept" list is exactly the images you wrote down, per repository. After two
`/verify` runs in a row, both newest revisions are `local-*` builds, so even the ghcr image
of the last CI deploy shows as "would remove". That's fine: no Pod runs it, and the
registry still has it.

Then think it through: Deploy F fails and Helm rolls back to E. Deploy G succeeds. Which
images does the next cleanup keep? (G's and E's. F's revision is `failed`, so it doesn't
count, and F's image goes.)

## Exercise: account for the disk

Do the accounting from [Where the runner's disk goes](#where-the-runners-disk-goes) and write the numbers down before reading on.

1. `df -h /` used, minus the readable folders, minus `docker system df` (host) and the `minikube` volume. How much is left unexplained? (Expected: a few GB, in root-only `/var/lib/containerd` and `/var/lib/docker`.)
2. Pick the members-service image inside minikube and find its biggest layer:
   ```bash
   eval "$(minikube docker-env)"
   docker history "$(kubectl get deploy members-service-members-service -o jsonpath='{..image}')" \
     --format '{{.Size}}\t{{.CreatedBy}}' | sort -h | tail -3
   eval "$(minikube docker-env -u)"
   # ~130MB  RUN addgroup … node        ← the node:20-alpine base
   # ~125MB  COPY … /prod/members-service ./   ← the app folder from pnpm deploy
   ```
   Expected: no layer near 800 MB. If you see `COPY /repo/node_modules`, that image predates CMS-33.
3. Predict, then check: does `docker builder prune -af --max-used-space 1GB` free anything right after a Deploy? Run `docker buildx du | tail -4` first. (Expected: it frees about Reclaimable − 1 GB, possibly over two passes, and never touches what's Shared with an image.)
