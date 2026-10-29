# Kubernetes Local Dev Runbook

This guide walks through deploying the full church-cms stack (Members service + Events service + web frontend) to a local minikube cluster with Traefik as the Ingress controller. Follow it top to bottom — each step depends on the previous one.

> **Quick start: one command.** [`scripts/cluster-up.sh`](../scripts/cluster-up.sh) runs every step
> below, plus the monitoring stack from [`observability.md`](observability.md), in the right order,
> then smoke-tests the result. Each line it prints is labelled with the section it comes from
> (`==> [k8s-local-dev §2] …`). It's safe to re-run at any time.
>
> ```bash
> scripts/cluster-up.sh               # create or update everything
> scripts/cluster-up.sh --skip-build  # reuse the images already in minikube
> scripts/cluster-up.sh --fresh       # delete the cluster first (wipes Postgres data!)
> ```
>
> The script is a convenience, not a replacement: **read the steps below** to learn what each one
> does. For §3 it asks for your `sudo` password **only if needed**: it starts `minikube tunnel` in
> the background and keeps a marked `# BEGIN church-cms` block in `/etc/hosts` pointing at
> Traefik's current IP, showing the diff and saving a backup first. Use `--no-sudo` to only check.

---

## Prerequisites

Make sure these are installed before starting:

```bash
minikube version   # v1.30+
kubectl version    # v1.27+
helm version       # v4.x
```

---

## 1. Start minikube

```bash
minikube start --memory 6g --cpus 4 --container-runtime docker
```

> **Why `--memory 6g`?** With the docker driver, minikube's node is a container with a memory cap
> (the default here was 3 GB). The apps, Traefik and the monitoring stack already use ~2.7 GB of
> it, and the Events service and NATS come next. The cap can only be set when the cluster is
> **created**: an existing cluster needs `minikube delete` (or `scripts/cluster-up.sh --fresh`).
> Measured with everything installed (CMS-29: apps, NATS, Prometheus, Grafana, Loki, Alloy, Tempo
> and the OTel Collector): **~3.5 GB of the 6**. Tempo (~280 Mi) and the Collector (~70 Mi) added
> ~0.4 GB. Check per Pod with `kubectl top pods -A --sort-by=memory`.
> Check the real cap with `docker inspect minikube --format '{{.HostConfig.Memory}}'`. Note that
> `free` *inside* the node shows the host's RAM, not the cap.
>
> **Why `--container-runtime docker`?** Step 4 builds images straight into minikube's Docker
> daemon (`minikube docker-env`), which only exists with the Docker runtime. minikube v1.39+
> switches the default to containerd, so we pin it.

Expected output ends with:
```
Done! kubectl is now configured to use "minikube" cluster and "default" namespace by default
```

Verify the cluster is up:

```bash
kubectl get nodes
# NAME       STATUS   ROLES           AGE   VERSION
# minikube   Ready    control-plane   ...   v1.x
```

---

## 2. Install Traefik (Ingress controller)

Traefik is the Ingress controller — it watches Ingress resources and routes external traffic into the cluster.

```bash
helm repo add traefik https://traefik.github.io/charts
helm repo update

helm upgrade --install traefik traefik/traefik \
  --version 41.6.1 \
  --namespace traefik --create-namespace \
  -f k8s/traefik-values.yaml
```

The settings live in [`k8s/traefik-values.yaml`](../k8s/traefik-values.yaml), with a comment on
each. `--version` pins the chart so a reinstall gives the same Traefik.

Wait for Traefik to be ready:

```bash
kubectl -n traefik rollout status deployment/traefik
# deployment "traefik" successfully rolled out
```

> **What `ports.traefik.expose.default=true` does:** Exposes the Traefik API/dashboard port (8080) so we can route to it via Ingress. `ingressRoute.dashboard.enabled=false` disables Traefik's own self-generated IngressRoute so we can manage routing ourselves with a standard Ingress.

---

## 3. Configure /etc/hosts and minikube tunnel

Minikube's Docker driver does not expose port 80 directly from the host. You need two things: an `/etc/hosts` entry and `minikube tunnel` running in a background terminal.

**Step A — start the tunnel** (keep this terminal open the entire session):

```bash
sudo -E minikube tunnel
# Prompts for sudo password, then sits running — leave it open
```

`minikube tunnel` assigns `127.0.0.1` as the external IP for LoadBalancer services (including Traefik), making port 80 accessible from the host.

**Step B — add the hostname** (run once):

```bash
echo "127.0.0.1  cms.local traefik.cms.local" | sudo tee -a /etc/hosts
```

> **Which IP?** On some setups the tunnel gives Traefik its cluster IP (e.g.
> `10.109.105.150`) instead of `127.0.0.1`. Ask the cluster rather than guessing:
> `kubectl -n traefik get svc traefik` → `EXTERNAL-IP`, and use that address. The
> monitoring stack adds `grafana.cms.local` on the same address
> ([`observability.md`](observability.md) §4).

Verify:

```bash
ping -c 1 cms.local
# PING cms.local (127.0.0.1): ...
```

> **Note:** The tunnel must be running whenever you want to use `http://cms.local`. If you stop and restart minikube, simply restart the tunnel too.

> **"another tunnel is already running", but none is.** minikube records each tunnel's
> PID in `~/.minikube/tunnels.json` and refuses to start a second one while that PID is
> alive. After a reboot the dead tunnel's PID can be handed to an unrelated process, so
> the stale record looks alive. Check, then move the record aside and start again:
>
> ```bash
> tail -3 /tmp/minikube-tunnel.log   # cluster-up.sh's tunnel log
> # X Exiting due to SVC_TUNNEL_START: ... another tunnel is already running ... Pid: 28594
> ps -p 28594 -o cmd                 # not "minikube tunnel"? the record is stale
> ip route | grep 10.96              # no route = no tunnel is really running
> mv ~/.minikube/tunnels.json ~/.minikube/tunnels.json.stale
> scripts/cluster-up.sh --skip-build # starts the tunnel again (asks for sudo)
> ```

---

## 4. Build Docker images inside minikube

Minikube runs its own Docker daemon, separate from your host machine. You must build images inside it — otherwise Kubernetes can't find them.

```bash
# Point your shell's Docker CLI at minikube's daemon
eval $(minikube docker-env)

# Tag the images with the current commit (see "Why not just :local?" below)
TAG=local-$(git rev-parse --short HEAD)

# Build members-service
docker build -f apps/members-service/Dockerfile -t members-service:$TAG .

# Build events-service
docker build -f apps/events-service/Dockerfile -t events-service:$TAG .

# Build web frontend
docker build -f apps/web/Dockerfile -t church-cms-web:$TAG .
```

Verify the images are visible to minikube:

```bash
docker images | grep -E "members-service|events-service|church-cms-web"
# members-service    local-a986bf0   <id>   ...
# events-service     local-a986bf0   <id>   ...
# church-cms-web     local-a986bf0   <id>   ...
```

> **Why not just `:local`?** Kubernetes replaces Pods only when the Pod *spec* changes. If you rebuild `members-service:local` and run `helm upgrade` with `image.tag=local` again, the spec is identical, so Helm reports a new revision and **the old Pods keep running the old code**. You end up testing a build that no longer exists. A tag that changes with the code (the commit SHA) changes the spec, so Helm rolls the Pods. CI's deploy uses the same idea with `ghcr.io/…:<sha>`. `scripts/cluster-up.sh` goes one step further: uncommitted edits get a `-dirty-<hash>` suffix, so every different working tree gets its own tag.
>
> `$TAG` only lives in the terminal where you set it. In a new terminal, run the `TAG=` line again before any `helm` command below; they stop with *run the TAG= line from §4 first* if you forget, instead of deploying an empty tag.
>
> If you edit code without committing, `$TAG` doesn't change. Either commit first, run `scripts/cluster-up.sh`, or pick a new tag by hand (`TAG=local-try2`).

> **Note:** `eval $(minikube docker-env)` only lasts for the current terminal session. If you open a new terminal you must run it again before any `docker` commands.

---

## 5. Deploy Postgres

Postgres runs as a plain Kubernetes Deployment (not via Helm — it's infrastructure, not the app).
There are **two**, one per service (ADR-0008): `members-postgres` and `events-postgres`.
They are separate Pods with separate volumes, so neither service can read the other's
tables, and one database going down doesn't take the other service with it.

```bash
kubectl apply -f k8s/postgres.yaml -f k8s/events-postgres.yaml
```

Wait for both Pods to reach Running:

```bash
kubectl get pods -l 'app in (members-postgres, events-postgres)' --watch
# events-postgres-xxx    1/1   Running   0   30s
# members-postgres-xxx   1/1   Running   0   30s
# Press Ctrl+C when both are Running
```

> **If the Pod stays Pending:** the PersistentVolumeClaim may still be provisioning. Run `kubectl get pvc` and wait for `STATUS` to show `Bound`, then the Pod will start automatically.

### 5b. Install NATS (the message bus)

The two services exchange domain events (`MemberArchived`, `AttendanceRecorded`)
through NATS JetStream, installed like Traefik: a Helm chart, in its own namespace.
Do it **before** the services, so they connect on their first try. (They'd keep
retrying if it were missing, and HTTP still works, but no events would flow.)

```bash
helm repo add nats https://nats-io.github.io/k8s/helm/charts/
helm upgrade --install nats nats/nats --version 2.15.0 \
  -n nats --create-namespace -f k8s/nats-values.yaml --wait
kubectl get pods -n nats
# nats-0                     2/2   Running   0   40s
# nats-box-...               1/1   Running   0   40s
```

What NATS is, what the values do, and how to watch events flow:
[`messaging.md`](messaging.md).

---

## 6. Prisma migrations (automatic)

Migrations now run automatically: each members-service and events-service Pod has a `migrate` init container that runs `prisma migrate deploy` before the app starts (`migrations.enabled` in `charts/members-service/values.yaml`). You can skip straight to step 7.

Check what it did:

```bash
kubectl logs <members-service-pod> -c migrate
# No pending migrations to apply.   (or "All migrations have been successfully applied.")
```

**Manual fallback** (e.g. with `--set migrations.enabled=false`): port-forward Postgres to localhost temporarily, run the migration, then close the tunnel.

> **nvm users:** nvm is not loaded in non-interactive shells. Run `source ~/.nvm/nvm.sh` first if `pnpm` is not found.

```bash
# Open the tunnel in the background
kubectl port-forward svc/members-postgres 5432:5432 &

# Run migrations
DATABASE_URL="postgresql://cms_user:cms_password@localhost:5432/members_db" \
  pnpm --filter members-service exec prisma migrate deploy

# Close the tunnel
kill %1
```

Expected output includes:
```
All migrations have been successfully applied.
```

---

## 7. Deploy Members service

```bash
helm upgrade --install members-service ./charts/members-service \
  --set image.tag="${TAG:?run the TAG= line from §4 first}" \
  --set image.pullPolicy=Never \
  --set ingress.enabled=true
```

Expected output:
```
NAME: members-service
STATUS: deployed
REVISION: 1
```

> **`helm upgrade --install`** is idempotent — it installs on first run and upgrades on subsequent runs. Prefer it over bare `helm install`.

---

## 7b. Deploy Events service

The chart is a copy of the members one with different names, ports (3002, metrics 9465)
and Ingress path (`/api/events`), so the command is the same:

```bash
helm upgrade --install events-service ./charts/events-service \
  --set image.repository=events-service \
  --set image.tag="${TAG:?run the TAG= line from §4 first}" \
  --set image.pullPolicy=Never \
  --set ingress.enabled=true \
  --set metrics.serviceMonitor.enabled=true \
  --wait --timeout 4m
# STATUS: deployed

kubectl get pods -l app.kubernetes.io/name=events-service
# events-service-events-service-xxx   1/1   Running   0   20s   (x2)

kubectl logs deploy/events-service-events-service -c migrate
# 1 migration found in prisma/migrations
# All migrations have been successfully applied.   (on the Pod that ran first)
# No pending migrations to apply.                  (on the other one)
```

> **`--set metrics.serviceMonitor.enabled=true`** needs the monitoring stack's CRDs
> ([`observability.md`](observability.md) §2). Leave it out on a cluster without them.

**Try the real feature.** Every check-in needs a `memberId` that came from the Members
context, so take one from members-service first:

```bash
MEMBER=$(curl -s 'http://cms.local/api/members/members?limit=1' | jq -r '.data[0].id')
WHEN=$(date -u -d '+1 hour' +%Y-%m-%dT%H:%M:%SZ)   # check-in opens 2 h before the start

EVENT=$(curl -s -X POST http://cms.local/api/events/events -H 'content-type: application/json' \
  -d "{\"title\":\"Sunday Morning Service\",\"eventType\":\"service\",\"venue\":{\"name\":\"Main Sanctuary\"},
       \"scheduledAt\":\"$WHEN\",\"durationMinutes\":90,\"createdById\":\"$MEMBER\"}" | jq -r .id)

curl -s -X POST "http://cms.local/api/events/events/$EVENT/attendance" \
  -H 'content-type: application/json' -d "{\"memberId\":\"$MEMBER\"}"
# {"id":"…"}                                                  ← 201
curl -s -X POST "http://cms.local/api/events/events/$EVENT/attendance" \
  -H 'content-type: application/json' -d "{\"memberId\":\"$MEMBER\"}"
# {"error":"Member is already checked in to this event"}      ← 409
```

The full endpoint list is in [`events-service-ddd.md`](events-service-ddd.md) §6.

> **No tunnel? Test without sudo.** `minikube tunnel` needs root. A port-forward to
> Traefik doesn't, and still goes through the real Ingress rules and middlewares:
>
> ```bash
> kubectl -n traefik port-forward svc/traefik 18080:80 &
> curl -s -H 'Host: cms.local' http://127.0.0.1:18080/api/events/health
> # {"status":"ok"}
> kill %1
> ```
>
> The `Host` header is what the Ingress matches on (`host: cms.local`), so it stands in
> for the `/etc/hosts` entry.

---

## 8. Deploy web frontend

```bash
helm upgrade --install web ./charts/web \
  --set image.tag="${TAG:?run the TAG= line from §4 first}" \
  --set image.pullPolicy=Never \
  --set ingress.enabled=true
```

---

## 9. Apply Traefik dashboard Ingress

```bash
kubectl apply -f k8s/traefik-dashboard-ingress.yaml
```

---

## 10. Verify the full stack

```bash
# All pods should be Running
kubectl get pods
# members-postgres-xxx                1/1   Running
# members-service-members-service-xxx 1/1   Running   (x2, HPA managed)
# events-postgres-xxx                 1/1   Running
# events-service-events-service-xxx   1/1   Running   (x2, HPA managed)
# web-web-xxx                         1/1   Running

# All ingress resources should be present
kubectl get ingress
# NAME                      CLASS     HOSTS       ...
# members-service-...       traefik   cms.local   ...
# events-service-...        traefik   cms.local   ...
# web-web                   traefik   cms.local   ...

kubectl get ingress -n traefik
# traefik-dashboard         traefik   traefik.cms.local ...
```

### Acceptance criteria

```bash
# 1. Members API health
curl http://cms.local/api/members/health
# Expected: {"status":"ok"}

# 1b. Events API health
curl http://cms.local/api/events/health
# Expected: {"status":"ok"}

# 2. Frontend (should return HTML)
curl -I http://cms.local
# Expected: HTTP/1.1 200 OK

# 2b. The members page can reach members-service. A 200 isn't enough here: when the
#     web Pod can't reach the API, the page still returns 200, with an error box.
curl -s http://cms.local/members | grep -c "Could not load members"
# Expected: 0

# 3. Traefik dashboard
curl -I http://traefik.cms.local/dashboard/
# Expected: HTTP/1.1 200 OK
# Or open in browser: http://traefik.cms.local/dashboard/
```

---

## How Traefik routing works

```
Browser / curl
     │
     ▼
minikube IP (cms.local)
     │
     ▼
Traefik (Ingress controller, namespace: traefik)
     │
     ├── /api/members/* ──[StripPrefix /api/members]──► members-service:3001
     │                                                     /health, /members, ...
     │
     ├── /api/events/*  ──[StripPrefix /api/events]───► events-service:3002
     │                                                     /health, /events, ...
     │
     └── /*  ─────────────────────────────────────────► web:3000
```

The **StripPrefix middleware** (`charts/members-service/templates/middleware.yaml`) rewrites the path before forwarding: `cms.local/api/members/health` → members-service at `/health`.

---

## Upgrading after a chart change

> **With CI/CD set up, you usually don't need this section.** Merging to `main` builds and deploys changed services automatically. See [ci-cd.md](ci-cd.md). Use the commands below only to try out an unmerged change by hand. Note that a manual deploy replaces the pipeline's `ghcr.io/…:<sha>` image with your `local-<sha>` one until the next merge deploys again.

```bash
# Rebuild first if the code changed (§4), with a NEW $TAG, or the Pods won't restart.
# Re-deploy members-service after chart or image change
helm upgrade --install members-service ./charts/members-service \
  --set image.tag="${TAG:?run the TAG= line from §4 first}" \
  --set image.pullPolicy=Never \
  --set ingress.enabled=true

# Re-deploy events-service after chart or image change
helm upgrade --install events-service ./charts/events-service \
  --set image.repository=events-service \
  --set image.tag="${TAG:?run the TAG= line from §4 first}" \
  --set image.pullPolicy=Never \
  --set ingress.enabled=true

# Re-deploy web after chart or image change
helm upgrade --install web ./charts/web \
  --set image.tag="${TAG:?run the TAG= line from §4 first}" \
  --set image.pullPolicy=Never \
  --set ingress.enabled=true
```

---

## Teardown

Remove all Helm releases, Postgres, and Traefik:

```bash
helm uninstall members-service
helm uninstall events-service
helm uninstall web
helm uninstall traefik -n traefik
kubectl delete -f k8s/postgres.yaml -f k8s/events-postgres.yaml
kubectl delete -f k8s/traefik-dashboard-ingress.yaml
kubectl delete namespace traefik
```

Stop minikube (preserves the cluster state — faster to restart next time):

```bash
minikube stop
```

To delete the cluster entirely and start fresh next time:

```bash
minikube delete
```

---

## Debugging cheatsheet

| Symptom | Command |
|---|---|
| Pod stuck in `Pending` | `kubectl describe pod <name>` → check Events |
| Pod in `CrashLoopBackOff` | `kubectl logs <pod-name>` |
| `ImagePullBackOff` | `docker images \| grep members-service` (with minikube docker-env active) |
| `pnpm: command not found` | `source ~/.nvm/nvm.sh` |
| `curl cms.local` connection refused | Traefik not running — `kubectl -n traefik get pods` |
| Ingress not routing | `kubectl describe ingress <name>` → check backend service name |
| Middleware not applying | `kubectl get middleware` — must exist in `default` namespace |
| `/etc/hosts` stale after `minikube delete` | Re-run step 3 with new `minikube ip` |
| `cannot reuse a name` | `helm uninstall <name>` then reinstall |
| minikube unreachable | `minikube status` → if Stopped, run `minikube start` |
| `cms.local` doesn't answer and you can't `sudo` for the tunnel | Port-forward Traefik and send `Host: cms.local` (§7b) |
| `zsh: no matches found: http://…?limit=1` | zsh reads `?` as a glob: quote the URL |
| An API returns `500` with `P1001 Can't reach database server` | That service's Postgres is down: `kubectl get pods -l app=<svc>-postgres` (see Exercise 2) |
| `/members` shows "Could not load members. Try again in a moment." | The reason is in the web log, not on the page: `kubectl logs deploy/web-web \| grep -A3 "Could not load members from"`. If the URL there is `http://localhost:3001`, the Pod has no `MEMBERS_API_URL` and is calling itself: `kubectl exec deploy/web-web -- printenv MEMBERS_API_URL` should print `http://members-service-members-service:3001` (set by `config.membersApiUrl` in `charts/web/values.yaml`) |
| `/` returns `502` or `000` for a moment during a rollout | The old Pod exited while Traefik still routed to it. Check the `preStop` sleep is there: `kubectl get deploy web-web -o jsonpath='{.spec.template.spec.containers[0].lifecycle}'` should print `{"preStop":{"sleep":{"seconds":5}}}`. Empty means `shutdown.preStopSeconds` is `0` (see the rollout-gap exercise) |
| The registration form says "Couldn't reach the members service" | Same check as above, then `kubectl get pods -l app.kubernetes.io/instance=members-service` |

---

## Exercises: two contexts, two databases

Run these after §7b. Each one shows the expected result so you can check yourself.
They use the variables from §7b (`MEMBER`, `EVENT`, `WHEN`).

**1. A rule only the database can enforce.** Create a fresh event, then fire two check-ins
for the same member *at the same moment*:

```bash
EVENT2=$(curl -s -X POST http://cms.local/api/events/events -H 'content-type: application/json' \
  -d "{\"title\":\"Prayer Meeting\",\"eventType\":\"event\",\"venue\":{\"name\":\"Chapel\"},
       \"scheduledAt\":\"$WHEN\",\"durationMinutes\":60,\"createdById\":\"$MEMBER\"}" | jq -r .id)
for i in 1 2; do
  curl -s -o /dev/null -w '%{http_code}\n' -X POST "http://cms.local/api/events/events/$EVENT2/attendance" \
    -H 'content-type: application/json' -d "{\"memberId\":\"$MEMBER\"}" &
done; wait
```

Expected: one `201` and one `409` (in either order), never two `201`s. Both requests may
pass the use case's "already checked in?" check, but the unique index on
`(eventId, memberId)` lets only one INSERT win. Why that matters:
[`events-service-ddd.md`](events-service-ddd.md) §3.2.

**2. Break one database on purpose.** Stop the Events database and watch both services:

```bash
kubectl scale deploy/events-postgres --replicas=0

curl -s http://cms.local/api/events/health
# {"status":"ok"}                ← still "healthy": /health doesn't touch the database
curl -s -o /dev/null -w '%{http_code}\n' http://cms.local/api/events/events
# 500                            ← the body says P1001 "Can't reach database server at events-postgres:5432"
curl -s -o /dev/null -w '%{http_code}\n' http://cms.local/api/members/members
# 200                            ← Members doesn't notice: its database is a different server
kubectl get pods -l app.kubernetes.io/name=events-service
# … 1/1 Running                  ← Pods stay Ready: the probes only check /health

kubectl scale deploy/events-postgres --replicas=1
kubectl rollout status deploy/events-postgres
curl -s -o /dev/null -w '%{http_code}\n' http://cms.local/api/events/events
# 200                            ← Prisma reconnects by itself; no restart needed
```

Things to think about: should readiness fail when the database is down? (It would stop
traffic to Pods that can't serve it, but a liveness check that did the same would restart
healthy Pods in a loop.) And should a 500 reveal a database hostname to the client?
(It shouldn't. Both services still use Fastify's default error body, which is a known gap.)

**3. Look for the boundary.** Ask each database which tables it has:

```bash
kubectl exec deploy/members-postgres -- psql -U cms_user -d members_db -tAc \
  "select tablename from pg_tables where schemaname='public'"
# _prisma_migrations
# Member
kubectl exec deploy/events-postgres -- psql -U cms_user -d events_db -tAc \
  "select tablename from pg_tables where schemaname='public'"
# _prisma_migrations
# ServiceEvent
# Attendance
# VolunteerAssignment
```

Expected: no `Member` table in `events_db`, and no events tables in `members_db`. The
`memberId` in `Attendance` is just text: try to `JOIN` it to `Member` and you'll find
there's nothing to join to.

**4. A rule that spans aggregates.** Assign two roles, then cancel the event:

```bash
for role in usher greeter; do
  curl -s -X POST "http://cms.local/api/events/events/$EVENT/volunteers" -H 'content-type: application/json' \
    -d "{\"memberId\":\"$MEMBER\",\"role\":\"$role\",\"assignedById\":\"$MEMBER\"}"; echo
done
curl -s -o /dev/null -w '%{http_code}\n' -X POST "http://cms.local/api/events/events/$EVENT/cancel" \
  -H 'content-type: application/json' -d '{"reason":"Storm warning"}'
# 204
kubectl exec deploy/events-postgres -- psql -U cms_user -d events_db -tAc \
  "select role, status from \"VolunteerAssignment\" where \"eventId\" = '$EVENT' order by role"
# greeter|declined
# usher|declined
```

Then try to bring it back: `PUT` a new title and expect
`400 {"error":"Cannot update a cancelled event"}`. A cancelled event can't go back to
scheduled (ADR-0004). Cancelling it *again* returns `204` and changes nothing: cancel is
idempotent, so a cancel that failed half-way can simply be retried
([`events-service-ddd.md`](events-service-ddd.md) §3.3).

## Exercise: the stale-image trap

Why §4 tags images by commit instead of `:local`. You'll deploy a fixed tag, rebuild under
it, and watch Kubernetes keep running the old build. Run it with the stack up.

```bash
eval $(minikube docker-env)
CUR=$(kubectl get deploy members-service-members-service -o jsonpath='{.spec.template.spec.containers[0].image}')
docker tag "$CUR" members-service:trap
helm upgrade members-service ./charts/members-service --reuse-values \
  --set image.repository=members-service --set image.tag=trap --set image.pullPolicy=Never --wait | grep REVISION
# REVISION: 16                       ← the tag changed, so the Pod spec changed: new Pods
kubectl get pods -l app.kubernetes.io/instance=members-service
# members-service-members-service-6c958f89c6-ng528   1/1   Running   0   39s
# members-service-members-service-6c958f89c6-xjbzd   1/1   Running   0   26s

# Now "change the code" and rebuild under the SAME tag
echo "// trap exercise" >> apps/members-service/src/index.ts
docker build -q -f apps/members-service/Dockerfile -t members-service:trap .
git checkout -- apps/members-service/src/index.ts
helm upgrade members-service ./charts/members-service --reuse-values \
  --set image.repository=members-service --set image.tag=trap --set image.pullPolicy=Never --wait | grep REVISION
# REVISION: 17                       ← Helm says it upgraded…
kubectl get pods -l app.kubernetes.io/instance=members-service
# members-service-members-service-6c958f89c6-ng528   …  ← …but these are the SAME two Pods

docker image inspect members-service:trap --format '{{.Id}}' | cut -c1-19
# sha256:5fc790279609                ← what the tag points to now (the new build)
kubectl get pods -l app.kubernetes.io/instance=members-service \
  -o jsonpath='{.items[0].status.containerStatuses[0].imageID}' | sed 's/.*sha256:/sha256:/' | cut -c1-19
# sha256:f4e24367dbbe                ← what the Pod actually runs (the old build)
```

`image.repository` and `pullPolicy` are set too because after a CI deploy the release points at `ghcr.io/…`, which has no `:trap` tag.

Expected: the two IDs differ. Every request you send now tests code that isn't in your
tree any more. That's exactly how a "verified" change could be wrong before
`/verify` asserted the image tag (study-guide §12.2). Your hashes will be different from
these; the point is that they don't match.

Fix it the way the script does: `scripts/cluster-up.sh --no-sudo` builds
`local-<sha>[-dirty-<hash>]`, the Pod spec changes, and new Pods start. Its smoke test
then prints `✔ members-service-members-service runs members-service:local-…`. Run the script a
second time with no code change: the tag is the same, so the Pod names don't change.
Clean up the extra tag with `docker rmi members-service:trap`.

---

## Exercise: the rollout gap

Why every chart has a `preStop` sleep (study-guide §7.8). You'll send traffic while
restarting web, first without the sleep and then with it, and count the failed requests.
Run it with the stack up.

```bash
# Background loop: request / and /members over and over (~15 a second), one line per response.
probe() {
  while true; do
    for p in / /members; do
      echo "$p $(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://cms.local$p)"
    done
    sleep 0.1
  done
}
# Probe, restart web, keep probing while the old Pod stops, then count the non-200s.
rollout_probe() {
  probe > /tmp/probe.log &
  local pid=$!
  sleep 3
  kubectl rollout restart deploy/web-web >/dev/null
  kubectl rollout status deploy/web-web >/dev/null
  sleep 15
  kill $pid
  echo "$(wc -l < /tmp/probe.log) requests, $(grep -vc ' 200$' /tmp/probe.log) non-200"
  grep -v ' 200$' /tmp/probe.log
}
```

**1. Without the sleep.** `0` makes the chart leave the hook out entirely:

```bash
helm upgrade web ./charts/web --reuse-values --set shutdown.preStopSeconds=0 --wait | grep STATUS
# STATUS: deployed
kubectl get deploy web-web -o jsonpath='{.spec.template.spec.containers[0].lifecycle}'; echo
#                                    ← empty: no preStop hook
rollout_probe; rollout_probe; rollout_probe
# 416 requests, 3 non-200
# / 502
# /members 502
# / 000                              ← no answer within 3 s
# 376 requests, 3 non-200
# …
# 418 requests, 0 non-200            ← a race: some rollouts get lucky
```

Expected: at least one run has failures, all within a fraction of a second. They come
from the **old** Pod: it got SIGTERM and exited while Traefik was still routing to it. The
new Pod was Ready the whole time, which is why Ready isn't the same as safe to remove.

**2. With the sleep:**

```bash
helm upgrade web ./charts/web --reuse-values --set shutdown.preStopSeconds=5 --wait | grep STATUS
# STATUS: deployed
kubectl get deploy web-web -o jsonpath='{.spec.template.spec.containers[0].lifecycle}'; echo
# {"preStop":{"sleep":{"seconds":5}}}
sleep 10   # see below
rollout_probe; rollout_probe; rollout_probe
# 474 requests, 0 non-200
# 482 requests, 0 non-200
# 480 requests, 0 non-200
```

Expected: 0 non-200 every time. Your request counts will differ.

Why the `sleep 10`: this `helm upgrade` is itself a rollout, and the Pod it stops is the
**old** one, created with `preStopSeconds=0`. A Pod stops according to its own spec, so that
one has no hook and exits at once. Probe straight away and you catch it: a single `502` or
`000` in the first run, before the restart even starts. The same happens once for real: the
Deploy that first ships the hook replaces Pods that don't have it yet.

**3. Watch the old Pod stop.** In a second terminal, run `kubectl get pods -l app=web-web -w`,
then `kubectl rollout restart deploy/web-web` in the first. The old Pod shows `Terminating`
for about 6 s: the 5 s sleep, then Next.js exits about a second after SIGTERM. Now try
`kubectl get pod <old-pod> -o jsonpath='{.metadata.deletionTimestamp}'` while it's stopping:
the time is about **30 s in the future**. It's the SIGKILL deadline (start + grace period),
not the moment stopping began.

To try the services, replace `web-web` with `members-service-members-service` in
`rollout_probe`: `/members` calls members-service, so the loop covers it. Neither page
calls events-service, so for that one change the URLs in `probe` to `/api/events/health`.

Clean up with `rm /tmp/probe.log`. The next `scripts/cluster-up.sh` resets any values you
changed here.

---

## Exercise: register a member through the UI

Follow one registration from the browser to the database (study-guide §5). Run it with
the stack up. You need a desktop browser for the DevTools part.

1. Open DevTools (<kbd>F12</kbd>) → **Network**, and tick **Preserve log** (a redirect
   clears the list otherwise). Go to <http://cms.local/members> and click **Register member**.
2. Register someone new, e.g. "Ruth Example" with `ruth@example.com`, phone empty.
   Expected:
   - You land on `/members` with a green **Registered Ruth Example** banner, and Ruth is in the list.
   - In Network, the `new` row is a **POST** answered **303 See Other**. Under *Headers*
     there's no `Location`; instead there's `x-action-redirect: /members?registered=<Ruth's id>;push`. The URL carries her id, not
     her name: the list page looks the name up, so nobody can craft a link with a fake banner.
     With JavaScript on, the form posts with `fetch`, and Next.js streams the `/members`
     page back **in the same response**, so its client router switches page without a
     second request. The URL bar still changes to `/members?registered=…`.
   - *Payload* on the POST shows `name` and `email`. The request headers include
     `Next-Action: <id>`, which tells Next.js which Server Action to run.
   - Want the classic two-request Post/Redirect/Get? DevTools → ⋮ → *Run command* →
     "Disable JavaScript", and submit again: now the POST is answered `303` with
     `Location: /members?registered=…`, and the browser sends its own GET. Same action,
     same result. Re-enable JavaScript afterwards.
3. Press **Refresh**. Expected: a GET only. No resubmission prompt, and no second Ruth.
4. Go back to the form and register `ruth@example.com` again. Expected: a red
   **Email already registered** banner, both fields still filled in, and the POST answered
   **200**, not 303. The error came back with the page; nothing redirected.
5. Check the row in Postgres:

   ```bash
   kubectl exec deploy/members-postgres -- sh -c \
     'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "select name, email, phone from \"Member\" where email = '"'"'ruth@example.com'"'"'"'
   #      name     |      email       | phone
   # --------------+------------------+-------
   #  Ruth Example | ruth@example.com |          ← phone is NULL: a blank field is left out, not stored as ""
   # (1 row)
   ```

6. **Break it on purpose.** Point the web Pod at a wrong URL, then register someone:

   ```bash
   kubectl set env deploy/web-web MEMBERS_API_URL=http://nowhere:3001
   kubectl rollout status deploy/web-web
   # deployment "web-web" successfully rolled out
   ```

   Expected: `/members` shows *Could not load members. Try again in a moment.* (no
   internal address on the page). The reason is in the log:

   ```bash
   kubectl logs deploy/web-web | grep -A3 "Could not load members from" | tail -4
   # Could not load members from http://nowhere:3001: TypeError: fetch failed
   #     at async h (.next/server/app/members/page.js:2:7533)
   #     at async k (.next/server/app/members/page.js:2:8160) {
   #   [cause]: [Error: getaddrinfo EAI_AGAIN nowhere] {     ← DNS can't resolve "nowhere"
   ```

   The form shows **Couldn't reach the members service, try again.** with your values kept, and
   `scripts/cluster-up.sh --no-sudo` would now fail. Restore the chart's value:

   ```bash
   helm upgrade web ./charts/web --reuse-values --wait
   # Error: UPGRADE FAILED: conflict occurred while applying object default/web-web …
   #   conflict with "kubectl-set" … env[name="MEMBERS_API_URL"].value
   helm upgrade web ./charts/web --reuse-values --force-conflicts --wait | grep REVISION
   # REVISION: …
   kubectl exec deploy/web-web -- printenv MEMBERS_API_URL
   # http://members-service-members-service:3001
   ```

   Why the first upgrade fails: Helm 4 uses **server-side apply**, where the API server
   records which client owns each field. `kubectl set env` took ownership of that one
   value, so Helm won't silently overwrite it. `--force-conflicts` takes it back. It's
   the same protection that stops two tools fighting over a resource without anyone noticing.

---

## Next: observability and messaging

To see metrics and dashboards for what you just deployed (Prometheus, Grafana,
metrics-server for the HPA), follow [`observability.md`](observability.md).
To watch the two services talk to each other through NATS, follow
[`messaging.md`](messaging.md).
