#!/usr/bin/env bash
# Every env var an app reads must be set by that app's Helm chart.
#
#   scripts/check-env.sh        # exit 1 if a chart misses a variable its app reads
#
# Why: in CMS-26 the web app read MEMBERS_API_URL, docker-compose.yml set it, but
# charts/web never did. On minikube the app fell back to localhost and /members was
# broken, while lint, typecheck, tests and CI all passed. This is the check that
# would have failed.
#
# How: for each apps/<app> that has a charts/<app>, collect `process.env.X` and
# `process.env["X"]` *reads* in non-test source, then look for X as a whole word in
# charts/<app>/templates. A self-default like `process.env.X ??= "none"` is a write,
# not a read, and is skipped. Destructuring (`const { X } = process.env`) isn't
# detected; the code base doesn't use it.
#
# docker-compose.yml is deliberately not checked: local dev may rely on a variable's
# fallback (LOG_LEVEL, METRICS_PORT). The deploy target is what must be explicit.
#
# Allowed without a chart entry: variables the platform sets itself.
set -euo pipefail
cd "$(dirname "$0")/.."

ALLOWED=(NODE_ENV)   # set by Next.js / the Dockerfile for every app

missing=0
for chart in charts/*/; do
  app=$(basename "$chart")
  [[ -d "apps/$app" ]] || continue

  mapfile -t vars < <(
    grep -rhoE 'process\.env(\.[A-Z_][A-Z0-9_]*|\["[A-Z_][A-Z0-9_]*"\])[[:space:]]*(\?\?=|=[^=])?' \
      "apps/$app" --include='*.ts' --include='*.tsx' \
      --exclude='*.test.ts' --exclude='*.test.tsx' \
      --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=generated --exclude-dir=dist \
      | grep -vE '(\?\?=|=[^=])$' \
      | sed -E 's/^process\.env(\.|\[")//; s/"\].*//; s/[^A-Z0-9_].*//' \
      | sort -u
  )

  for var in "${vars[@]}"; do
    [[ " ${ALLOWED[*]} " == *" $var "* ]] && continue
    if grep -rqw -- "$var" "$chart/templates"; then
      echo "✔ $app: $var is set in $chart""templates"
    else
      echo "✘ $app reads $var, but $chart""templates never sets it (add it to the Deployment's env, value from values.yaml)"
      missing=$((missing + 1))
    fi
  done
done

if (( missing > 0 )); then
  echo "$missing variable(s) missing from charts"
  exit 1
fi
echo "env OK"
