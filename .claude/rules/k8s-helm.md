---
paths:
  - "charts/**"
  - "k8s/**"
  - ".github/workflows/**"
  - "**/Dockerfile"
  - "docker-compose*.yml"
---

# Kubernetes, Helm, Docker and CI conventions

- **Teaching comments are part of the code here.** Explain what each non-obvious field does and why, matching the style in `apps/members-service/Dockerfile` and `charts/members-service/values.yaml`. Don't strip existing ones.
- **New chart features go behind a values flag that defaults to off** when they depend on something the cluster may lack, such as CRDs. Turn the flag on in `.github/workflows/deploy.yml` with `--set`. The chart must still render with defaults.
- Naming convention: `apps/<svc>/Dockerfile` ↔ `charts/<svc>` ↔ Helm release `<svc>` ↔ image `ghcr.io/<repo>/<svc>`. The deploy matrix depends on this.
- One-time cluster add-ons (Traefik, monitoring) are installed by hand from the runbooks with values files in `k8s/`. They are not deployed by `deploy.yml`.
- Database strategy (ADR-0008): Postgres runs as a StatefulSet with a PVC in minikube, one per service.
- Credentials go in K8s Secrets and env vars, never in values or manifests that get committed.
- Before finishing, run `helm lint` and `helm template` with the flags deploy.yml passes, and render every new flag both on and off. For `k8s/` manifests, run `kubectl apply --dry-run=server`. For workflows, run `actionlint` (config in `.github/actionlint.yaml`).
- Any change under `apps/<svc>/` or `charts/<svc>/` redeploys that service after merge, including test-only changes.
