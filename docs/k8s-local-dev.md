# Kubernetes Local Dev Runbook

This guide walks through deploying the Members service to a local minikube cluster from scratch. Follow it top to bottom — each step depends on the previous one.

---

## Prerequisites

Make sure these are installed before starting:

```bash
minikube version   # v1.30+
kubectl version    # v1.27+
helm version       # v3.x
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

## 2. Build the Docker image inside minikube

Minikube runs its own Docker daemon, separate from your host machine. You must build the image inside it — otherwise Kubernetes can't find it.

```bash
# Point your shell's Docker CLI at minikube's daemon
eval $(minikube docker-env)

# Build from the repo root (the Dockerfile requires monorepo context)
docker build -f apps/members-service/Dockerfile -t members-service:local .
```

Verify the image is visible to minikube:

```bash
docker images | grep members-service
# members-service   local   <id>   ...
```

> **Note:** `eval $(minikube docker-env)` only lasts for the current terminal session. If you open a new terminal you must run it again before any `docker` commands.

---

## 3. Deploy Postgres

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

## 4. Run Prisma migrations

The database schema must be applied before the Members service starts. Port-forward Postgres to localhost temporarily, run the migration, then close the tunnel.

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

## 5. Install the Helm chart

```bash
helm install members-service ./charts/members-service
```

Expected output:
```
NAME: members-service
STATUS: deployed
REVISION: 1
```

> **If you get "cannot reuse a name that is still in use":** a previous install is still tracked. Run `helm uninstall members-service` then retry.

---

## 6. Verify the deployment

```bash
# All three pods should be Running: 1 postgres + 2 members-service
kubectl get pods

# Check the HPA is wired up
kubectl get hpa

# Check the Service exists
kubectl get svc
```

Expected pods:
```
members-postgres-xxx                    1/1   Running
members-service-members-service-xxx     1/1   Running
members-service-members-service-xxx     1/1   Running
```

---

## 7. Test the health endpoint

Port 3001 may already be in use on your machine. Use 3002 to be safe:

```bash
kubectl port-forward svc/members-service-members-service 3002:3001
```

In a second terminal:

```bash
curl http://localhost:3002/health
# {"status":"ok"}
```

Press `Ctrl+C` in the first terminal to close the port-forward when done.

---

## Upgrading after a chart change

```bash
helm upgrade members-service ./charts/members-service
```

To override a value without editing `values.yaml`:

```bash
helm upgrade members-service ./charts/members-service --set replicaCount=3
```

---

## Teardown

Remove the Helm release and Postgres:

```bash
helm uninstall members-service
kubectl delete -f k8s/postgres.yaml
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
| Port already in use | Use a different local port: `port-forward ... 3002:3001` |
| `cannot reuse a name` | `helm uninstall members-service` then reinstall |
| minikube unreachable | `minikube status` → if Stopped, run `minikube start` |
