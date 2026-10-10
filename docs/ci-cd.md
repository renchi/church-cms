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

The first push creates two packages: `ghcr.io/renchi/church-cms/members-service` and `.../web`. minikube pulls them without credentials, so they must be public. For each package, go to GitHub → your profile → **Packages** → package → **Package settings** → **Change visibility** → Public.

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
| See migration output | `kubectl logs <members-pod> -c migrate` |
| Roll back | `helm rollback <release>` (or revert the commit; the next deploy ships the old code) |

Only services whose files changed are rebuilt:

- `apps/<svc>/**` and `charts/<svc>/**` trigger that service only.
- Shared files (`pnpm-lock.yaml`, `package.json`, `tsconfig.base.json`, `packages/**`, the workflow itself) trigger both.
- A manual run always deploys both.

Every image is tagged with the **commit SHA**, plus a moving `main` tag. The SHA tag makes it obvious which commit is running and makes every deploy a real change that Kubernetes rolls out.

### Migrations and rollbacks (expand/contract)

The members-service `migrate` init container applies migrations **before** the new Pods are known to be healthy. If they then fail readiness, `helm --rollback-on-failure` rolls back the image, but **not the schema**. The old code then runs against the new schema.

So every migration must work with **both** the old and new code:

| Change | Release N (expand) | Release N+1 (contract) |
|---|---|---|
| Add a column | add it nullable / with a default | make it required, if needed |
| Rename a column | add new column, write to both, backfill | read from new, drop old |
| Drop a column | stop reading/writing it in code | drop it |

---

## Debugging

| Symptom | Likely cause / fix |
|---|---|
| Deploy job stuck in "Queued" | Runner offline: `sudo ~/actions-runner/svc.sh status`, then `start` |
| `docker: permission denied` in runner | Runner user not in `docker` group: `sudo usermod -aG docker $USER`, then restart the service |
| `kubernetes cluster unreachable` | minikube stopped: `minikube start` |
| `helm: command not found` | Runner PATH is stale; see the note in setup step 1 |
| Pods `ImagePullBackOff` | GHCR package still private (setup step 3), or the push failed |
| Helm "UPGRADE FAILED … rolled back" | New Pods never became Ready. Check `kubectl describe pod` and `kubectl logs <pod> -c migrate` |
| `denied: permission_denied` on push | Package not linked to the repo. In package settings → **Manage Actions access**, add `church-cms` with write access |
| CI `integration-tests` fails, others pass | Testcontainers couldn't start Postgres. Check the job log for Docker errors |
| CI jobs **cancelled** with "The job was not acquired by Runner of type hosted" | A GitHub Actions outage (check <https://www.githubstatus.com>), not a test failure. Re-run once it recovers: `gh run rerun <id> --failed` |
| `failed to run git: not a git repository` from `gh` | The terminal isn't inside the repo. `cd ~/church-cms`, or add `-R renchi/church-cms` |
