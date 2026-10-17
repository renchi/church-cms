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

Deploy the branch with the bootstrap script. It builds every image under a tag derived from the code (`local-<sha>`, plus `-dirty-<hash>` for uncommitted edits), so Helm actually rolls the Pods. Don't rebuild under a fixed tag like `:local`: the spec doesn't change, the old Pods keep running, and you'd be verifying stale code.

```bash
scripts/cluster-up.sh --no-sudo        # ends with "✔ <svc> runs <svc>:local-<sha>…" per service, then the smoke test
kubectl get deploy <svc>-<svc> -o jsonpath='{.spec.template.spec.containers[0].image}'   # must show this run's tag
kubectl logs deploy/<svc>-<svc> --tail=50    # no errors or stack traces
```

If the script reports the tunnel or `/etc/hosts` as wrong, ask the user to run `scripts/cluster-up.sh --skip-build` once **in their own terminal** (it needs sudo). Not with the `!` prefix: that has no terminal, so sudo can't ask for the password. Don't skip the feature check.

**Exercise the actual feature.** Hit the new or changed endpoint, dashboard or flow, and show the response. One request through the real feature counts as verification; a health check alone does not.

## 5. Docs (always)

```bash
scripts/check-docs.sh    # errors: broken links / line links past the end of a file. Warnings: line links into files this branch changed
```

Fix every error. For each warning, open the linked line and either confirm it still points at the right code or fix the link. Then check that the learning deliverables from `.claude/rules/docs-learning.md` exist for this ticket (study-guide section with all four parts, self-check questions, runbook with expected output and exercises). Follow the new runbook steps as written and check they produce the output the doc claims.

## Report

End with a short table of each step, the result (pass, fail or skipped) and the evidence (a command output excerpt). Don't call the ticket verified if any step failed. Next: `/code-review`, then `/ship`.
