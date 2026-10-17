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
#   - `process.env.X`, `process.env?.X`, `process.env["X"]` / `['X']` in .ts/.tsx/.js/.mjs/.cjs
#     source, outside tests and test helpers (*.test.*, vitest.*, test/, tests/, __tests__/). A write
#     (`process.env.X ??= …` or `= …`, even with the value on the next line) is not a read.
#   - `env("X")` in apps/<app>/prisma/*.prisma (Prisma reads DATABASE_URL this way).
#   - the same reads in a workspace package the app depends on (packages/*, e.g. @cms/events).
# Destructuring or aliasing process.env (`const { X } = process.env`) can't be checked,
# so it's an error: read `process.env.X` directly.
#
# What counts as set: the chart rendered with the flags Deploy passes (`helm template`),
# then the `env:` entries of the Deployment's app containers (`containers:`, not
# `initContainers:`: a migration init container having DATABASE_URL says nothing about
# the app), and the keys of the ConfigMaps it renders (the charts load theirs with
# envFrom). A name in a comment, or in a block that's off by default, doesn't count.
# The parser relies on Helm's rendered indentation (spec.template.spec keys at 6
# spaces) and fails if it finds no app container, rather than guessing.
#
# Not demanded from the chart: NEXT_PUBLIC_* (inlined into the browser bundle at
# build time, so a Dockerfile build arg, not the Pod's env) and ALLOWED below
# (set by the platform, or by a Secret the chart doesn't render).
#
# docker-compose.yml is deliberately not checked: local dev may rely on a variable's
# fallback (LOG_LEVEL, METRICS_PORT). The deploy target is what must be explicit.
#
# Fails closed: a grep or helm error fails the check rather than reading as "no variables".
set -euo pipefail
cd "$(dirname "$0")/.."

ALLOWED=(NODE_ENV)   # set by Next.js / the Dockerfile for every app. Add a key of an
                     # externally created Secret (envFrom secretRef) here, with a comment.
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

SRC_OPTS=(-rE --include='*.ts' --include='*.tsx' --include='*.js' --include='*.mjs' --include='*.cjs'
          --exclude='*.test.*' --exclude='vitest.*'
          --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=generated --exclude-dir=dist
          --exclude-dir=test --exclude-dir=tests --exclude-dir=__tests__)

# Variables read in TS source under the given directories.
ts_reads() {
  local hits
  hits=$(grep_or_die -ho "${SRC_OPTS[@]}" \
    "process\\.env(\\??\\.[A-Z_][A-Z0-9_]*|\\[[\"'][A-Z_][A-Z0-9_]*[\"']\\])[[:space:]]*(\\?\\?=|=([^=]|\$))?" "$@")
  [[ -n "$hits" ]] || return 0
  grep -vE '(\?\?=|=([^=]|$))$' <<<"$hits" | sed -E "s/^process\.env(\?\.|\.|\[[\"'])//; s/[^A-Z0-9_].*//" || true
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
      name=$(jq -r .name "$dir/package.json")   # a jq error stops the script (set -e)
      if [[ "$name" == "$dep" ]]; then echo "${dir%/}"; fi
    done
  done
}

for chart in charts/*/; do
  app=$(basename "$chart")
  [[ -d "apps/$app" ]] || continue

  # Assigned first, not `mapfile < <(…)`: a jq failure inside a process substitution
  # would silently drop the packages from the scan.
  pkgs=$(package_dirs "$app")
  mapfile -t dirs <<<"apps/$app${pkgs:+$'\n'$pkgs}"

  unsupported=$(ts_unsupported "${dirs[@]}")
  [[ -z "$unsupported" ]] || fail "$app: process.env is destructured or aliased, so its reads can't be checked; use process.env.X:"$'\n'"$unsupported"

  reads=$(ts_reads "${dirs[@]}")
  prisma=""
  if compgen -G "apps/$app/prisma/*.prisma" >/dev/null; then
    prisma=$(grep_or_die -hoE 'env\("[A-Z_][A-Z0-9_]*"\)' "apps/$app"/prisma/*.prisma | sed -E 's/env\("//; s/"\)//')
  fi
  vars=$(printf '%s\n%s\n' "$reads" "$prisma" | sed '/^$/d' | sort -u)

  rendered=$(helm template "$app" "$chart" "${DEPLOY_FLAGS[@]}")
  # Env entries of the Deployment's app containers, plus the data keys of every
  # rendered ConfigMap (loaded via envFrom). A line "containers" marks that an app
  # container section was found, so a layout the parser doesn't know fails loudly.
  parsed=$(awk '
    /^---/                              { kind = ""; section = ""; in_data = 0 }
    /^kind: /                           { kind = $2 }
    kind == "ConfigMap" && /^data:/     { in_data = 1; next }
    in_data && /^[^ ]/                  { in_data = 0 }
    in_data && /^  [A-Z_][A-Z0-9_]*:/   { k = $1; sub(/:$/, "", k); print k }
    kind == "Deployment" && /^      [A-Za-z]+:/ { section = $1; sub(/:$/, "", section)
                                          if (section == "containers") print "<containers>" }
    kind == "Deployment" && section == "containers" && /^ *- name: [A-Z_][A-Z0-9_]*$/ { print $3 }
  ' <<<"$rendered")
  if ! grep -qxF '<containers>' <<<"$parsed"; then
    fail "$app: found no Deployment containers: section in the rendered $chart (has the layout changed?)"
    continue
  fi
  set_vars=$(grep -vxF '<containers>' <<<"$parsed" | sort -u)

  while IFS= read -r var; do
    [[ -z "$var" || " ${ALLOWED[*]} " == *" $var "* || "$var" == NEXT_PUBLIC_* ]] && continue
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
