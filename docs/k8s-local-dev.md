# Kubernetes Local Dev Runbook

This guide walks through deploying the full church-cms stack (Members service + web frontend) to a local minikube cluster with Traefik as the Ingress controller. Follow it top to bottom — each step depends on the previous one.

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
minikube start
```

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

helm install traefik traefik/traefik \
  --namespace traefik --create-namespace \
  --set ports.traefik.expose.default=true \
  --set ingressRoute.dashboard.enabled=false \
  --set api.insecure=true
```

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

# Build web frontend
docker build -f apps/web/Dockerfile -t church-cms-web:local .
```

Verify both images are visible to minikube:

```bash
docker images | grep -E "members-service|church-cms-web"
# members-service    local   <id>   ...
# church-cms-web     local   <id>   ...
```

> **Note:** `eval $(minikube docker-env)` only lasts for the current terminal session. If you open a new terminal you must run it again before any `docker` commands.

---

## 5. Deploy Postgres

Postgres runs as a plain Kubernetes Deployment (not via Helm — it's infrastructure, not the app).

```bash
kubectl apply -f k8s/postgres.yaml
```

Wait for the Pod to reach Running:

```bash
kubectl get pods -l app=members-postgres --watch
# members-postgres-xxx   1/1   Running   0   30s
# Press Ctrl+C when Running
```

> **If the Pod stays Pending:** the PersistentVolumeClaim may still be provisioning. Run `kubectl get pvc` and wait for `STATUS` to show `Bound`, then the Pod will start automatically.

---

## 6. Prisma migrations (automatic)

Migrations now run automatically: each members-service Pod has a `migrate` init container that runs `prisma migrate deploy` before the app starts (`migrations.enabled` in `charts/members-service/values.yaml`). You can skip straight to step 7.

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
# web-web-xxx                         1/1   Running

# All ingress resources should be present
kubectl get ingress
# NAME                      CLASS     HOSTS       ...
# members-service-...       traefik   cms.local   ...
# web-web                   traefik   cms.local   ...

kubectl get ingress -n traefik
# traefik-dashboard         traefik   traefik.cms.local ...
```

### Acceptance criteria

```bash
# 1. Members API health
curl http://cms.local/api/members/health
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
helm uninstall web
helm uninstall traefik -n traefik
kubectl delete -f k8s/postgres.yaml
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

---

## Next: observability

To see metrics and dashboards for what you just deployed (Prometheus, Grafana,
metrics-server for the HPA), follow [`observability.md`](observability.md).
