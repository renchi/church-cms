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

---

## 4. Build Docker images inside minikube

Minikube runs its own Docker daemon, separate from your host machine. You must build images inside it — otherwise Kubernetes can't find them.

```bash
# Point your shell's Docker CLI at minikube's daemon
eval $(minikube docker-env)

# Build members-service
docker build -f apps/members-service/Dockerfile -t members-service:local .

# Build events-service
docker build -f apps/events-service/Dockerfile -t events-service:local .

# Build web frontend
docker build -f apps/web/Dockerfile -t church-cms-web:local .
```

Verify the images are visible to minikube:

```bash
docker images | grep -E "members-service|events-service|church-cms-web"
# members-service    local   <id>   ...
# events-service     local   <id>   ...
# church-cms-web     local   <id>   ...
```

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
  --set image.tag=local \
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
  --set image.tag=local \
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
  --set image.tag=local \
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

> **With CI/CD set up, you usually don't need this section.** Merging to `main` builds and deploys changed services automatically. See [ci-cd.md](ci-cd.md). Use the commands below only to try out an unmerged change by hand. Note that a manual deploy replaces the pipeline's `ghcr.io/…:<sha>` image with your `:local` one until the next merge deploys again.

```bash
# Re-deploy members-service after chart or image change
helm upgrade --install members-service ./charts/members-service \
  --set image.tag=local \
  --set image.pullPolicy=Never \
  --set ingress.enabled=true

# Re-deploy events-service after chart or image change
helm upgrade --install events-service ./charts/events-service \
  --set image.repository=events-service \
  --set image.tag=local \
  --set image.pullPolicy=Never \
  --set ingress.enabled=true

# Re-deploy web after chart or image change
helm upgrade --install web ./charts/web \
  --set image.tag=local \
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

Then cancel it again: expect `400 {"error":"Event is already cancelled"}`. A cancelled
event can't go back to scheduled (ADR-0004).

---

## Next: observability

To see metrics and dashboards for what you just deployed (Prometheus, Grafana,
metrics-server for the HPA), follow [`observability.md`](observability.md).
