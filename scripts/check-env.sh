#!/usr/bin/env bash
# Every env var an app reads must be set by that app's Helm chart, as rendered.
#
#   scripts/check-env.sh        # exit 1 if a chart doesn't set a variable its app reads
#
# Why: in CMS-26 the web app read MEMBERS_API_URL, docker-compose.yml set it, but
# charts/web never did. On minikube the app fell back to localhost and /members was
# broken, while lint, typecheck, tests and CI all passed. This is the check that
# would have failed.
#
# What counts as a read, per apps/<app> that has a charts/<app>:
#   - `process.env.X` and `process.env["X"]` in non-test .ts/.tsx source. A write
#     (`process.env.X ??= …` or `= …`, even with the value on the next line) is not a read.
#   - `env("X")` in apps/<app>/prisma/*.prisma (Prisma reads DATABASE_URL this way).
#   - the same reads in a workspace package the app depends on (packages/*, e.g. @cms/events).
# Destructuring or aliasing process.env (`const { X } = process.env`) can't be checked,
# so it's an error: read `process.env.X` directly.
#
# What counts as set: the chart rendered with the flags Deploy passes (`helm template`),
# then every `env:` entry (`- name: X`) and every key of a ConfigMap it renders (the
# charts load theirs with envFrom). A name in a comment, or in a block that's off by
# default, doesn't count, because it never reaches the Pod.
#
# docker-compose.yml is deliberately not checked: local dev may rely on a variable's
# fallback (LOG_LEVEL, METRICS_PORT). The deploy target is what must be explicit.
#
# Fails closed: a grep or helm error fails the check rather than reading as "no variables".
set -euo pipefail
cd "$(dirname "$0")/.."

ALLOWED=(NODE_ENV)   # set by Next.js / the Dockerfile for every app
DEPLOY_FLAGS=(--set ingress.enabled=true --set metrics.serviceMonitor.enabled=true)   # as deploy.yml

fail() { echo "✘ $1"; problems=$((problems + 1)); }
problems=0

# grep exits 1 for "no match", which is fine here, and 2 for a real error, which isn't.
grep_or_die() {
  local out status=0
  out=$(grep "$@") || status=$?
  (( status <= 1 )) || { echo "check-env: grep failed ($status): grep $*" >&2; exit 2; }
  printf '%s' "$out"
}

SRC_OPTS=(-rE --include='*.ts' --include='*.tsx' --exclude='*.test.ts' --exclude='*.test.tsx'
          --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=generated --exclude-dir=dist)

# Variables read in TS source under the given directories.
ts_reads() {
  local hits
  hits=$(grep_or_die -ho "${SRC_OPTS[@]}" \
    'process\.env(\.[A-Z_][A-Z0-9_]*|\["[A-Z_][A-Z0-9_]*"\])[[:space:]]*(\?\?=|=([^=]|$))?' "$@")
  [[ -n "$hits" ]] || return 0
  grep -vE '(\?\?=|=([^=]|$))$' <<<"$hits" | sed -E 's/^process\.env(\.|\[")//; s/[^A-Z0-9_].*//' || true
}

# process.env used whole (destructured or aliased): reads we can't see.
ts_unsupported() {
  grep_or_die -n "${SRC_OPTS[@]}" '(\}|\w)[[:space:]]*=[[:space:]]*process\.env[[:space:]]*(;|$)' "$@"
}

# Directories of workspace packages that apps/<app> depends on.
package_dirs() {
  local app=$1 dep dir
  for dep in $(jq -r '(.dependencies // {}) + (.devDependencies // {}) | to_entries[]
                      | select(.value | startswith("workspace:")) | .key' "apps/$app/package.json"); do
    for dir in packages/*/; do
      [[ "$(jq -r .name "$dir/package.json")" == "$dep" ]] && echo "${dir%/}"
    done
  done
}

for chart in charts/*/; do
  app=$(basename "$chart")
  [[ -d "apps/$app" ]] || continue

  mapfile -t dirs < <(echo "apps/$app"; package_dirs "$app")

  unsupported=$(ts_unsupported "${dirs[@]}")
  [[ -z "$unsupported" ]] || fail "$app: process.env is destructured or aliased, so its reads can't be checked; use process.env.X:"$'\n'"$unsupported"

  reads=$(ts_reads "${dirs[@]}")
  prisma=""
  if compgen -G "apps/$app/prisma/*.prisma" >/dev/null; then
    prisma=$(grep_or_die -hoE 'env\("[A-Z_][A-Z0-9_]*"\)' "apps/$app"/prisma/*.prisma | sed -E 's/env\("//; s/"\)//')
  fi
  vars=$(printf '%s\n%s\n' "$reads" "$prisma" | sed '/^$/d' | sort -u)

  rendered=$(helm template "$app" "$chart" "${DEPLOY_FLAGS[@]}")
  # env entries, plus the data keys of every rendered ConfigMap (loaded via envFrom).
  set_vars=$(awk '
    /^---/                         { in_cm = 0; in_data = 0 }
    /^kind: ConfigMap/             { in_cm = 1 }
    in_cm && /^data:/              { in_data = 1; next }
    in_data && /^[^ ]/             { in_data = 0 }
    in_data && /^  [A-Z_][A-Z0-9_]*:/ { k = $1; sub(/:$/, "", k); print k }
    /^ *- name: [A-Z_][A-Z0-9_]*$/ { print $3 }
  ' <<<"$rendered" | sort -u)

  while IFS= read -r var; do
    [[ -z "$var" || " ${ALLOWED[*]} " == *" $var "* ]] && continue
    if grep -qxF -- "$var" <<<"$set_vars"; then
      echo "✔ $app: $var is set by $chart"
    else
      fail "$app reads $var, but the rendered $chart never sets it (add it to the Deployment's env, value from values.yaml)"
    fi
  done <<<"$vars"
done

if (( problems > 0 )); then
  echo "$problems problem(s)"
  exit 1
fi
echo "env OK"
