#!/usr/bin/env bash
# rum-smoke.sh — run CMS-30's browser-monitoring checks (scripts/rum-smoke.mjs) in a
# real headless browser, without installing one on this machine.
#
#   scripts/rum-smoke.sh
#
# Needs: the cluster from cluster-up.sh with rum.enabled and rum.debug on (both set
# there), and `minikube tunnel` running so cms.local answers (k8s-local-dev.md §3).
#
# How: the browser comes from Microsoft's Playwright image (Chromium and its system
# libraries; about 2 GB the first time it's pulled), so nothing is added to the
# repo's dependencies. The script's only package, `playwright`, is installed inside
# the container at the SAME version as the image: a mismatch fails with "Executable
# doesn't exist" (the library looks for a browser build the image doesn't have).
#
#   --network host  the container shares this machine's network, so it reaches the
#                   tunnel's Traefik IP and the port-forwards below on localhost;
#   --add-host      but not this machine's /etc/hosts: cms.local is added by hand,
#                   with the same IP your /etc/hosts gives it.
set -euo pipefail
cd "$(dirname "$0")/.."

PLAYWRIGHT_VERSION=1.64.1
IMAGE="mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble"

cms_ip=$(getent hosts cms.local | awk '{print $1; exit}')
[[ -n "$cms_ip" ]] || { echo "rum-smoke: cms.local doesn't resolve; see k8s-local-dev.md §3 (/etc/hosts)" >&2; exit 2; }
curl -s -m 5 -o /dev/null "http://cms.local/" || { echo "rum-smoke: http://cms.local doesn't answer; is minikube tunnel running?" >&2; exit 2; }

# Loki and Tempo have no Ingress: reach them through port-forwards, like cluster-up's
# smoke test. Local ports 13100/13200, so a port-forward you already run on 3100/3200
# doesn't clash.
kubectl -n monitoring port-forward svc/loki 13100:3100 >/dev/null 2>&1 &
loki_pf=$!
kubectl -n monitoring port-forward svc/tempo 13200:3200 >/dev/null 2>&1 &
tempo_pf=$!
trap 'kill $loki_pf $tempo_pf 2>/dev/null || true' EXIT
sleep 2

docker run --rm --network host --add-host "cms.local:$cms_ip" \
  -v "$PWD/scripts/rum-smoke.mjs:/work/rum-smoke.mjs:ro" -w /work \
  -e PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
  "$IMAGE" \
  bash -c "npm install --silent --no-audit --no-fund playwright@$PLAYWRIGHT_VERSION >/dev/null && node rum-smoke.mjs"
