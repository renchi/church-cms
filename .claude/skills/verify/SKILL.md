---
name: verify
description: Verify the current branch's change actually works — tests, typecheck, chart rendering, and the running app on minikube. Use after implementing a ticket and before /code-review.
---

# Verify the change

Confirm that the feature works in the running system, not just that it compiles. Run the steps that apply to what changed (`git diff --name-only main...HEAD`). **Report each step's real outcome.** If a step fails or is skipped, say so and give the reason.

## 1. Static checks (always)

For each changed package under `apps/` or `packages/`:

```bash
pnpm --filter <pkg> lint
pnpm --filter <pkg> typecheck
pnpm --filter <pkg> test:unit
pnpm --filter <pkg> test          # includes integration tests — needs Docker running (Testcontainers)
```

These mirror CI's `lint-typecheck`, `unit-tests` and `integration-tests` jobs, which branch protection requires.

## 2. Charts and manifests (if `charts/**` or `k8s/**` changed)

```bash
helm lint charts/<svc>
helm template charts/<svc> --set ingress.enabled=true   # + any flags deploy.yml passes
kubectl apply --dry-run=server -f k8s/<file>.yaml
```

Also render with every new values flag both on and off.

## 3. Image (if a `Dockerfile` or start command changed)

```bash
docker build -f apps/<svc>/Dockerfile -t <svc>:verify .
docker run --rm -p 3001:3001 <svc>:verify   # check it starts; Ctrl+C
```

## 4. Running app on minikube (if app code, chart, or k8s changed)

Prerequisites: `minikube status` shows Running, and `minikube tunnel` is open so `cms.local` resolves (see `docs/k8s-local-dev.md` §3).

Deploy the branch locally the same way the runbook does (`docs/k8s-local-dev.md` §4 and §7): build inside minikube's Docker, then `helm upgrade --install`. Then:

```bash
kubectl rollout status deploy/<svc>
kubectl get pods
curl -s http://cms.local/api/members/health
kubectl logs deploy/<svc> --tail=50          # no errors or stack traces
```

**Exercise the actual feature.** Hit the new or changed endpoint, dashboard or flow, and show the response. One request through the real feature counts as verification; a health check alone does not.

## 5. Docs (always)

Check that the learning deliverables from `.claude/rules/docs-learning.md` exist for this ticket. Then follow the new runbook steps as written and check they produce the expected output the doc claims.

## Report

End with a short table of each step, the result (pass, fail or skipped) and the evidence (a command output excerpt). Don't call the ticket verified if any step failed.
