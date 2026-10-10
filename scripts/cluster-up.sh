#!/usr/bin/env bash
# cluster-up.sh — bring up everything church-cms needs on minikube, in one go.
#
#   scripts/cluster-up.sh               create or update the cluster, build images, deploy
#   scripts/cluster-up.sh --skip-build  reuse the images already inside minikube
#   scripts/cluster-up.sh --fresh       DELETE the cluster first and start from nothing
#   scripts/cluster-up.sh --no-sudo     never use sudo: only check the tunnel and /etc/hosts
#
# This script does not replace the runbooks; it *runs* them. Every step prints
# the runbook section it comes from, e.g. "[k8s-local-dev §2]". To learn what a
# step does and why, read that section:
#   docs/k8s-local-dev.md   — minikube, Traefik, Postgres, images, Helm deploys
#   docs/observability.md   — metrics-server, Prometheus, Grafana
#
# Idempotent: safe to run again at any time. Every step either creates something
# or brings it to the declared state ("helm upgrade --install", "kubectl apply"),
# so a second run changes nothing that is already right. See study-guide §7.7.
#
# The two steps that need root (§3) are automated too, but visibly: the script
# asks for your sudo password, starts `minikube tunnel` in the background if it
# isn't running, and keeps a clearly marked "church-cms" block in /etc/hosts up to
# date (a backup is saved first). With --no-sudo it only checks and prints the fix.

set -euo pipefail   # stop on the first error, on unset variables, and on failures inside pipes

# --- Settings ----------------------------------------------------------------
# Versions are pinned so a run months from now installs exactly what was tested.
TRAEFIK_CHART_VERSION=41.6.1
KPS_CHART_VERSION=92.2.0          # kube-prometheus-stack
# Resources for a NEW cluster. Prometheus + Grafana + the apps already use ~2.7 GB;
# the Events service and NATS come next. An existing cluster can't be resized —
# that needs --fresh.
MINIKUBE_MEMORY_MB=6144
MINIKUBE_CPUS=4
# Pin the container runtime: we build images straight into minikube's Docker
# daemon (`minikube docker-env`, §4), which only exists with the docker runtime.
# minikube v1.39+ defaults to containerd, which would break that step.
MINIKUBE_RUNTIME=docker
HOSTNAMES=(cms.local traefik.cms.local grafana.cms.local)
HOSTS_FILE=/etc/hosts
TUNNEL_LOG=/tmp/minikube-tunnel.log

FRESH=false
SKIP_BUILD=false
USE_SUDO=true
for arg in "$@"; do
  case "$arg" in
    --fresh) FRESH=true ;;
    --skip-build) SKIP_BUILD=true ;;
    --no-sudo) USE_SUDO=false ;;
    -h | --help) sed -n '2,21p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

# Run from the repo root so relative paths (charts/, k8s/) work wherever you call it from.
cd "$(dirname "$0")/.."

# --- Helpers -----------------------------------------------------------------
step() { printf '\n\033[1;34m==> [%s] %s\033[0m\n' "$1" "$2"; }
ok()   { printf '    \033[32m✔\033[0m %s\n' "$1"; }
warn() { printf '    \033[33m!\033[0m %s\n' "$1"; }
fail() { printf '    \033[31m✘\033[0m %s\n' "$1"; }

# helm_quiet <helm args...> — run helm but show only its STATUS line instead of the long NOTES.
helm_quiet() { helm "$@" | { grep -E '^(STATUS|REVISION):' || true; } | paste -sd' ' | sed 's/^/    /'; }

# wait_for <seconds> <description> <command...> — retry until the command succeeds.
wait_for() {
  local timeout=$1 what=$2; shift 2
  local deadline=$((SECONDS + timeout))
  until "$@" >/dev/null 2>&1; do
    if ((SECONDS >= deadline)); then fail "timed out after ${timeout}s waiting for: $what"; return 1; fi
    sleep 3
  done
}

# --- Preflight ---------------------------------------------------------------
step "preflight" "Checking tools"
for tool in minikube kubectl helm docker jq curl; do
  command -v "$tool" >/dev/null || { fail "$tool is not installed (see docs/k8s-local-dev.md Prerequisites)"; exit 1; }
done
docker info >/dev/null 2>&1 || { fail "Docker is not running"; exit 1; }
ok "minikube, kubectl, helm, docker, jq, curl found; Docker is running"

# --- Optional: start from nothing -------------------------------------------
if $FRESH; then
  step "--fresh" "Deleting the minikube cluster"
  warn "This deletes EVERYTHING in the cluster, including the Postgres data (members)."
  read -r -p "    Type 'yes' to delete the cluster: " answer
  [[ "$answer" == "yes" ]] || { fail "Aborted — nothing was deleted."; exit 1; }
  minikube delete
fi

# --- 1. minikube --------------------------------------------------------------
step "k8s-local-dev §1" "minikube cluster"
if minikube profile list -o json 2>/dev/null | jq -e '.valid[]? | select(.Name == "minikube")' >/dev/null; then
  if minikube status >/dev/null 2>&1; then
    ok "cluster exists and is running"
  else
    minikube start          # existing cluster: start it with the settings it was created with
  fi
  # The docker driver caps the node container's memory. `free` inside the node
  # shows the HOST's RAM, so this is the reliable place to read the real limit.
  mem_mb=$(( $(docker inspect minikube --format '{{.HostConfig.Memory}}' 2>/dev/null || echo 0) / 1048576 ))
  if ((mem_mb > 0 && mem_mb < MINIKUBE_MEMORY_MB)); then
    warn "cluster has ${mem_mb} MB RAM; ${MINIKUBE_MEMORY_MB} MB is recommended (monitoring + upcoming services)."
    warn "Resizing needs a new cluster: scripts/cluster-up.sh --fresh  (deletes Postgres data)"
  fi
else
  minikube start --memory "$MINIKUBE_MEMORY_MB" --cpus "$MINIKUBE_CPUS" --container-runtime "$MINIKUBE_RUNTIME"
fi
kubectl get nodes

# --- metrics-server (for kubectl top and the HPA) -----------------------------
step "observability §1" "metrics-server addon"
minikube addons enable metrics-server

# --- 2. Traefik ---------------------------------------------------------------
step "k8s-local-dev §2" "Traefik Ingress controller (chart $TRAEFIK_CHART_VERSION)"
helm repo add traefik https://traefik.github.io/charts --force-update >/dev/null
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts --force-update >/dev/null
helm repo update traefik prometheus-community >/dev/null
helm_quiet upgrade --install traefik traefik/traefik \
  --version "$TRAEFIK_CHART_VERSION" \
  -n traefik --create-namespace \
  -f k8s/traefik-values.yaml \
  --wait --timeout 5m
ok "Traefik ready"

step "k8s-local-dev §9" "Traefik dashboard Ingress"
kubectl apply -f k8s/traefik-dashboard-ingress.yaml

# --- Monitoring stack --------------------------------------------------------
# Order matters: this installs the ServiceMonitor CRD that the members-service
# chart uses, so it must come BEFORE the apps.
step "observability §2" "kube-prometheus-stack (chart $KPS_CHART_VERSION) — Prometheus, Grafana, Alertmanager"
helm_quiet upgrade --install kube-prometheus-stack prometheus-community/kube-prometheus-stack \
  --version "$KPS_CHART_VERSION" \
  -n monitoring --create-namespace \
  -f k8s/monitoring/kube-prometheus-stack-values.yaml \
  --wait --timeout 8m
ok "monitoring stack ready"

step "observability §3" "Grafana dashboard"
kubectl apply -f k8s/monitoring/service-red-dashboard.yaml

# --- 5. Postgres -------------------------------------------------------------
step "k8s-local-dev §5" "Postgres for members-service"
kubectl apply -f k8s/postgres.yaml
kubectl rollout status deployment/members-postgres --timeout=3m

# --- 4. Images ---------------------------------------------------------------
# Build straight into minikube's own Docker daemon, so the cluster can use the
# images without a registry (that's why the charts get pullPolicy=Never below).
step "k8s-local-dev §4" "Docker images inside minikube"
eval "$(minikube docker-env)"
if $SKIP_BUILD; then
  for img in members-service:local church-cms-web:local; do
    created=$(docker image inspect "$img" --format '{{.Created}}' 2>/dev/null) \
      || { fail "$img not found in minikube — run without --skip-build"; exit 1; }
    warn "reusing $img (built ${created%%.*}). If the code changed since then, rebuild!"
  done
else
  docker build -f apps/members-service/Dockerfile -t members-service:local .
  docker build -f apps/web/Dockerfile -t church-cms-web:local .
  ok "built members-service:local and church-cms-web:local"
fi

# --- 7–8. Apps ---------------------------------------------------------------
# Migrations run automatically in members-service's init container (§6).
step "k8s-local-dev §7" "members-service (Helm)"
helm_quiet upgrade --install members-service ./charts/members-service \
  --set image.repository=members-service \
  --set image.tag=local \
  --set image.pullPolicy=Never \
  --set ingress.enabled=true \
  --set metrics.serviceMonitor.enabled=true \
  --wait --timeout 4m

step "k8s-local-dev §8" "web frontend (Helm)"
helm_quiet upgrade --install web ./charts/web \
  --set image.repository=church-cms-web \
  --set image.tag=local \
  --set image.pullPolicy=Never \
  --set ingress.enabled=true \
  --wait --timeout 4m

# --- 3. Tunnel and /etc/hosts ------------------------------------------------
# Both need root. We only use sudo when it's actually needed, say why first, and
# let sudo ask for the password itself (nothing is stored).
step "k8s-local-dev §3" "minikube tunnel and /etc/hosts"
network_ok=true

traefik_ip() { kubectl -n traefik get svc traefik -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null; }
has_traefik_ip() { [[ -n "$(traefik_ip)" ]]; }
# sudo is usable if allowed and either passwordless or we have a terminal to type into.
can_sudo() { $USE_SUDO && { sudo -n true 2>/dev/null || [[ -t 0 ]]; }; }

# render_hosts <hosts-file> <ip> — print the hosts file with our names pointing at <ip>.
# Removes our names from any other line (dropping lines left with only an IP),
# replaces the old managed block, and leaves every other line exactly as it was.
render_hosts() {
  awk -v names="${HOSTNAMES[*]}" -v ip="$2" '
    BEGIN { n = split(names, h, " "); for (i = 1; i <= n; i++) ours[h[i]] = 1 }
    /^# BEGIN church-cms/ { skip = 1; next }
    /^# END church-cms/   { skip = 0; next }
    skip { next }
    /^[[:space:]]*(#|$)/ { print; next }            # comments and blank lines: untouched
    {
      hit = 0; line = $1
      for (i = 2; i <= NF; i++) { if ($i in ours) hit = 1; else line = line "  " $i }
      if (!hit) print                                # not ours: byte-for-byte unchanged
      else if (line != $1) print line                # had other names too: keep those
    }
    END {
      print "# BEGIN church-cms (managed by scripts/cluster-up.sh; changes here are overwritten)"
      print ip "  " names
      print "# END church-cms"
    }' "$1"
}

# 3a. minikube tunnel: gives Traefik's LoadBalancer Service a reachable IP.
if ! has_traefik_ip; then
  if can_sudo; then
    warn "minikube tunnel is not running; starting it in the background (needs sudo)."
    sudo -v
    # nohup + & = keeps running after this script ends. Log: $TUNNEL_LOG
    sudo -E bash -c 'nohup minikube tunnel >"$1" 2>&1 &' _ "$TUNNEL_LOG"
    if wait_for 60 "Traefik external IP from minikube tunnel" has_traefik_ip; then
      ok "minikube tunnel started (log: $TUNNEL_LOG; stop it with: sudo pkill -f 'minikube tunnel')"
    fi
  fi
fi
ip=$(traefik_ip)
if [[ -z "$ip" ]]; then
  network_ok=false
  fail "Traefik has no external IP; minikube tunnel is not running."
  warn "Start it in another terminal and leave it open:  sudo -E minikube tunnel"
  warn "Then run this script again (with --skip-build) to finish the checks."
else
  ok "Traefik external IP: $ip (minikube tunnel is running)"

  # 3b. /etc/hosts: point our hostnames at that IP. The IP changes whenever the
  # cluster is recreated (--fresh), which is why this is automated.
  wrong=()
  for host in "${HOSTNAMES[@]}"; do
    [[ "$(getent hosts "$host" | awk '{print $1; exit}' || true)" == "$ip" ]] || wrong+=("$host")
  done
  if ((${#wrong[@]} == 0)); then
    ok "/etc/hosts: ${HOSTNAMES[*]} → $ip"
  else
    new_hosts=$(mktemp)
    render_hosts "$HOSTS_FILE" "$ip" >"$new_hosts"
    if can_sudo; then
      warn "/etc/hosts points ${wrong[*]} at the wrong address. Updating it (needs sudo):"
      diff "$HOSTS_FILE" "$new_hosts" | sed 's/^/        /' || true
      sudo cp "$HOSTS_FILE" "$HOSTS_FILE.church-cms.bak"
      # Read our own temp file as the user; only `tee` (the write) runs as root.
      # shellcheck disable=SC2024
      sudo tee "$HOSTS_FILE" <"$new_hosts" >/dev/null
      ok "/etc/hosts updated (backup: $HOSTS_FILE.church-cms.bak)"
    else
      network_ok=false
      fail "/etc/hosts points ${wrong[*]} at the wrong address (expected $ip)."
      warn "Fix it with:  echo \"$ip  ${HOSTNAMES[*]}\" | sudo tee -a /etc/hosts"
      warn "(and delete older lines for these names), or re-run without --no-sudo."
    fi
    rm -f "$new_hosts"
  fi
fi

# --- Smoke test --------------------------------------------------------------
step "smoke test" "Is everything actually working?"
smoke_ok=true
if $network_ok; then
  if [[ "$(curl -s -m 5 http://cms.local/api/members/health)" == '{"status":"ok"}' ]]; then
    ok "members API: http://cms.local/api/members/health → {\"status\":\"ok\"}"
  else
    smoke_ok=false; fail "members API health check failed"
  fi
  for url in http://cms.local/ http://grafana.cms.local/login; do
    code=$(curl -s -m 5 -o /dev/null -w '%{http_code}' "$url" || true)
    if [[ "$code" == 200 ]]; then
      ok "$url → 200"
    else
      smoke_ok=false; fail "$url returned $code"
    fi
  done
else
  warn "skipping HTTP checks until the tunnel and /etc/hosts are fixed (see above)"
fi

# Prometheus has no Ingress; reach it through a temporary port-forward.
kubectl -n monitoring port-forward svc/kube-prometheus-stack-prometheus 9090 >/dev/null 2>&1 &
pf_pid=$!
trap 'kill $pf_pid 2>/dev/null || true' EXIT
members_up() {
  curl -s 'http://localhost:9090/api/v1/targets?state=active' \
    | jq -e '[.data.activeTargets[] | select(.labels.job == "members-service" and .health == "up")] | length >= 2'
}
# A new ServiceMonitor takes the Operator ~1 minute to pick up (observability.md troubleshooting).
if wait_for 180 "members-service targets up in Prometheus" members_up; then
  ok "Prometheus scrapes members-service (2 pods up)"
else
  smoke_ok=false
fi

# --- Summary -----------------------------------------------------------------
step "done" "Finished in ${SECONDS}s"
cat <<EOF
    App                http://cms.local
    Members API        http://cms.local/api/members/members
    Traefik dashboard  http://traefik.cms.local/dashboard/
    Grafana            http://grafana.cms.local/d/cms-service-red   (user: admin)
    Grafana password   kubectl get secret -n monitoring -l app.kubernetes.io/component=admin-secret \\
                         -o jsonpath="{.items[0].data.admin-password}" | base64 --decode; echo
    Prometheus         kubectl -n monitoring port-forward svc/kube-prometheus-stack-prometheus 9090

    Next: send some traffic and watch the dashboard — docs/observability.md, exercises.
EOF
if $network_ok && $smoke_ok; then
  ok "everything is up and verified"
else
  fail "some checks failed — see the ✘ lines above"
  exit 1
fi
