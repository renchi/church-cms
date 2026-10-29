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
#   docs/messaging.md       — NATS JetStream, the message bus between services
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
NATS_CHART_VERSION=2.15.0
LOKI_CHART_VERSION=18.15.0        # grafana-community/loki (the OSS chart's home since 2026-03)
ALLOY_CHART_VERSION=1.13.1        # grafana/alloy
TEMPO_CHART_VERSION=3.2.0         # grafana-community/tempo (single binary)
OTELCOL_CHART_VERSION=0.176.0     # open-telemetry/opentelemetry-collector
# Resources for a NEW cluster. Prometheus + Grafana + both services + NATS fit in
# this. An existing cluster can't be resized — that needs --fresh.
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
  warn "This deletes EVERYTHING in the cluster, including the Postgres data (members and events)."
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
helm repo add nats https://nats-io.github.io/k8s/helm/charts/ --force-update >/dev/null
helm repo add grafana https://grafana.github.io/helm-charts --force-update >/dev/null
helm repo add grafana-community https://grafana-community.github.io/helm-charts --force-update >/dev/null
helm repo add open-telemetry https://open-telemetry.github.io/opentelemetry-helm-charts --force-update >/dev/null
helm repo update traefik prometheus-community nats grafana grafana-community open-telemetry >/dev/null
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

# --- Logs: Loki + Alloy --------------------------------------------------------
# Loki before Alloy, so Alloy's first pushes find it (Alloy would retry anyway).
# Grafana already has Loki as a data source (kube-prometheus-stack values).
step "observability §7" "Loki log store (chart $LOKI_CHART_VERSION)"
helm_quiet upgrade --install loki grafana-community/loki \
  --version "$LOKI_CHART_VERSION" \
  -n monitoring \
  -f k8s/monitoring/loki-values.yaml \
  --wait --timeout 5m
ok "Loki ready"

step "observability §8" "Alloy log agent, one per node (chart $ALLOY_CHART_VERSION)"
helm_quiet upgrade --install alloy grafana/alloy \
  --version "$ALLOY_CHART_VERSION" \
  -n monitoring \
  -f k8s/monitoring/alloy-values.yaml \
  --wait --timeout 3m
ok "Alloy ready"

# --- Traces: Tempo + the OTel Collector (CMS-29) ------------------------------
# Tempo before the Collector, so the Collector's first exports find it. Grafana
# already has Tempo as a data source (kube-prometheus-stack values), and the
# Collector's ServiceMonitor needs the Prometheus Operator's CRDs (§2, above).
step "observability §10" "Tempo trace store (chart $TEMPO_CHART_VERSION)"
helm_quiet upgrade --install tempo grafana-community/tempo \
  --version "$TEMPO_CHART_VERSION" \
  -n monitoring \
  -f k8s/monitoring/tempo-values.yaml \
  --wait --timeout 5m
ok "Tempo ready"

step "observability §11" "OTel Collector, the apps' trace pipeline (chart $OTELCOL_CHART_VERSION)"
helm_quiet upgrade --install otel-collector open-telemetry/opentelemetry-collector \
  --version "$OTELCOL_CHART_VERSION" \
  -n monitoring \
  -f k8s/monitoring/otel-collector-values.yaml \
  --wait --timeout 3m
ok "OTel Collector ready"

# --- 5. Postgres -------------------------------------------------------------
step "k8s-local-dev §5" "Postgres for members-service and events-service (one each, ADR-0008)"
kubectl apply -f k8s/postgres.yaml -f k8s/events-postgres.yaml
kubectl rollout status deployment/members-postgres --timeout=3m
kubectl rollout status deployment/events-postgres --timeout=3m

# --- NATS --------------------------------------------------------------------
# Before the apps, so they find it on their first connection attempt (they'd
# keep retrying anyway, and their outboxes would hold events until then).
step "messaging §1" "NATS JetStream (chart $NATS_CHART_VERSION)"
helm_quiet upgrade --install nats nats/nats \
  --version "$NATS_CHART_VERSION" \
  -n nats --create-namespace \
  -f k8s/nats-values.yaml \
  --wait --timeout 4m
ok "NATS ready"

# --- 4. Images ---------------------------------------------------------------
# Build straight into minikube's own Docker daemon, so the cluster can use the
# images without a registry (that's why the charts get pullPolicy=Never below).
#
# Why the tag is "local-<commit>" and not just "local": Helm (and Kubernetes)
# only roll out new Pods when the Pod *spec* changes. Rebuilding an image under
# the same tag changes the image, not the spec, so the old Pods keep running the
# old code — and anything you "verify" afterwards is testing stale code. A tag
# that changes whenever the code changes makes the spec change too, so Helm rolls
# the Pods. Same code → same tag → nothing restarts (still idempotent).
# The deploy pipeline does the same thing with ghcr.io/…:<sha> (docs/ci-cd.md).
IMAGES=(members-service events-service church-cms-web)
step "k8s-local-dev §4" "Docker images inside minikube"
eval "$(minikube docker-env)"
if $SKIP_BUILD; then
  # Reuse what's deployed now: the tag in members-service's Deployment spec. (Not
  # "the newest local-* image": an image rebuilt from cache keeps its old Created
  # time, so "newest" can be an older build.) With nothing deployed yet, fall back
  # to the newest members-service tag. All three images must have that tag.
  IMAGE_TAG=$(kubectl get deploy members-service-members-service \
    -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null | sed -n 's/.*:\(local-.*\)$/\1/p')
  [[ -n "$IMAGE_TAG" ]] \
    || IMAGE_TAG=$(docker images members-service --format '{{.Tag}}' | grep -m1 '^local-' || true)
  [[ -n "$IMAGE_TAG" ]] || { fail "no local-* images in minikube — run without --skip-build"; exit 1; }
  for img in "${IMAGES[@]}"; do
    created=$(docker image inspect "$img:$IMAGE_TAG" --format '{{.Created}}' 2>/dev/null) \
      || { fail "$img:$IMAGE_TAG not found in minikube — run without --skip-build"; exit 1; }
    warn "reusing $img:$IMAGE_TAG (built ${created%%.*}). If the code changed since then, rebuild!"
  done
else
  # A committed tree is tagged by its commit. Uncommitted edits add a short hash of
  # the diff (and of any new files), so each different working tree gets its own tag.
  IMAGE_TAG="local-$(git rev-parse --short HEAD)"
  if [[ -n "$(git status --porcelain)" ]]; then
    dirty=$({ git diff HEAD; git ls-files --others --exclude-standard -z | xargs -0 -r sha256sum; } \
      | sha256sum | cut -c1-8)
    IMAGE_TAG="$IMAGE_TAG-dirty-$dirty"
  fi
  docker build -f apps/members-service/Dockerfile -t "members-service:$IMAGE_TAG" .
  docker build -f apps/events-service/Dockerfile -t "events-service:$IMAGE_TAG" .
  docker build -f apps/web/Dockerfile -t "church-cms-web:$IMAGE_TAG" .
  ok "built members-service, events-service and church-cms-web as :$IMAGE_TAG"
fi

# --- 7–8. Apps ---------------------------------------------------------------
# Every app pushes its spans here (observability.md §11, the OTel Collector).
# The same value deploy.yml passes.
OTLP_ENDPOINT=http://otel-collector.monitoring.svc.cluster.local:4318
# Migrations run automatically in members-service's init container (§6).
step "k8s-local-dev §7" "members-service (Helm)"
helm_quiet upgrade --install members-service ./charts/members-service \
  --set image.repository=members-service \
  --set image.tag="$IMAGE_TAG" \
  --set image.pullPolicy=Never \
  --set ingress.enabled=true \
  --set tracing.otlpEndpoint="$OTLP_ENDPOINT" \
  --set metrics.serviceMonitor.enabled=true \
  --wait --timeout 4m

# Same flags as members-service: every backend service is deployed the same way.
step "k8s-local-dev §7b" "events-service (Helm)"
helm_quiet upgrade --install events-service ./charts/events-service \
  --set image.repository=events-service \
  --set image.tag="$IMAGE_TAG" \
  --set image.pullPolicy=Never \
  --set ingress.enabled=true \
  --set tracing.otlpEndpoint="$OTLP_ENDPOINT" \
  --set metrics.serviceMonitor.enabled=true \
  --wait --timeout 4m

step "k8s-local-dev §8" "web frontend (Helm)"
helm_quiet upgrade --install web ./charts/web \
  --set image.repository=church-cms-web \
  --set image.tag="$IMAGE_TAG" \
  --set image.pullPolicy=Never \
  --set ingress.enabled=true \
  --set tracing.otlpEndpoint="$OTLP_ENDPOINT" \
  --wait --timeout 4m

# Old local-* builds would pile up and fill the disk. They can go once no Pod
# uses them; removing them earlier could pull an image out from under a Pod that
# then restarts (pullPolicy=Never can't fetch it). --wait returns when the NEW
# Pods are Ready, but the old ones are still stopping then: the preStop sleep
# keeps them serving for a few seconds (CMS-32, study guide §7.8), and Docker
# refuses to remove an image a container still uses. So first wait until every
# Pod running one of our images runs THIS build's tag. Asking "which Pods run an
# old image?" rather than "which Pods are stopping?" also catches an old Pod the
# Deployment hasn't started stopping yet, and ignores unrelated stopping Pods
# (Postgres, exercises). A kubectl error counts as "none left": the prune below
# fails safe on its own, so cleanup never aborts the run.
old_pods() {
  local images
  images=$(IFS='|'; echo "${IMAGES[*]}")   # members-service|events-service|church-cms-web
  kubectl get pods -o jsonpath='{range .items[*]}{.metadata.name} {.spec.containers[0].image}{"\n"}{end}' 2>/dev/null \
    | grep -E " ($images):local-" | grep -v ":$IMAGE_TAG\$" || true
}
for _ in {1..30}; do   # up to ~60 s: 5 s preStop sleep + shutdown, with margin
  stale=$(old_pods)
  [[ -z "$stale" ]] && break
  sleep 2
done
[[ -z "$stale" ]] || warn "old Pods still running after 60s: $(cut -d' ' -f1 <<<"$stale" | xargs)"
# Same script as Deploy's cleanup, keeping 1: only the build Helm just deployed.
# (Locally a rollback is a rebuild, so there's no rollback image worth keeping.)
releases=(members-service events-service web)   # same order as IMAGES
for i in "${!IMAGES[@]}"; do
  scripts/prune-deploy-images.sh "${releases[$i]}" "${IMAGES[$i]}" 1 >/dev/null \
    || warn "couldn't clean up old ${IMAGES[$i]} images (disk may fill; see docs/ci-cd.md)"
done
# Build cache inside minikube grows with every build here. Cap it by size, with
# the same script (and cap) as Deploy's cleanup job: the newest layers stay.
scripts/prune-build-cache.sh >/dev/null \
  || warn "couldn't cap minikube's build cache (scripts/prune-build-cache.sh failed)"

# --- 3. Tunnel and /etc/hosts ------------------------------------------------
# Both need root. We only use sudo when it's actually needed, say why first, and
# let sudo ask for the password itself (nothing is stored).
step "k8s-local-dev §3" "minikube tunnel and /etc/hosts"
network_ok=true

traefik_ip() { kubectl -n traefik get svc traefik -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null; }
# Is Traefik actually reachable from this machine? Don't trust the IP recorded on
# the Service alone: Kubernetes keeps it after the tunnel dies, and the route the
# tunnel added can outlive it too (until a reboot). Any HTTP answer counts, even
# a 404; only "can't connect" means we need a tunnel.
traefik_reachable() { local ip; ip=$(traefik_ip); [[ -n "$ip" ]] && curl -s -m 3 -o /dev/null "http://$ip/"; }
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
if ! traefik_reachable; then
  if can_sudo; then
    warn "minikube tunnel is not running; starting it in the background (needs sudo)."
    sudo -v
    # nohup + & = keeps running after this script ends. Log: $TUNNEL_LOG
    sudo -E bash -c 'nohup minikube tunnel >"$1" 2>&1 &' _ "$TUNNEL_LOG"
    if wait_for 60 "Traefik reachable through minikube tunnel" traefik_reachable; then
      ok "minikube tunnel started (log: $TUNNEL_LOG; stop it with: sudo pkill -f 'minikube tunnel')"
    fi
  fi
fi
ip=$(traefik_ip)
if ! traefik_reachable; then
  network_ok=false
  fail "Traefik isn't reachable${ip:+ at $ip}; minikube tunnel is not running."
  # Without a terminal (an agent, CI, Claude Code's "!" prefix) sudo can't ask for
  # a password, so the script didn't even try. Say so, or it looks like a bug.
  $USE_SUDO && ! can_sudo && warn "No terminal to type a sudo password into, so the tunnel wasn't started."
  warn "Start it in another terminal and leave it open:  sudo -E minikube tunnel"
  warn "Then run this script again (with --skip-build) to finish the checks."
else
  ok "Traefik reachable at $ip"

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
# Are the Pods running the images we just built? (The stale-image check, §4.)
# Deployments are named <release>-<chart> by the charts (e.g. members-service-members-service).
for deploy in members-service-members-service events-service-events-service web-web; do
  running=$(kubectl get deploy "$deploy" -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null \
    || echo "nothing (Deployment not found)")
  if [[ "$running" == *":$IMAGE_TAG" ]]; then
    ok "$deploy runs $running"
  else
    smoke_ok=false; fail "$deploy runs $running, expected tag $IMAGE_TAG"
  fi
done
if $network_ok; then
  for svc in members events; do
    if [[ "$(curl -s -m 5 "http://cms.local/api/$svc/health")" == '{"status":"ok"}' ]]; then
      ok "$svc API: http://cms.local/api/$svc/health → {\"status\":\"ok\"}"
    else
      smoke_ok=false; fail "$svc API health check failed"
    fi
  done
  for url in http://cms.local/ http://grafana.cms.local/login; do
    code=$(curl -s -m 5 -o /dev/null -w '%{http_code}' "$url" || true)
    if [[ "$code" == 200 ]]; then
      ok "$url → 200"
    else
      smoke_ok=false; fail "$url returned $code"
    fi
  done
  # A status code isn't enough for /members: when web can't reach members-service
  # the page still returns 200, with an error box. So check the content too, and
  # look for what a working page shows (the table, or "No members yet"), not just
  # for the absence of the error: an empty body or a 502 also lacks the error text.
  # -f makes curl fail on 4xx/5xx, so those land in the "else" branch.
  members_page=$(curl -sf -m 5 http://cms.local/members || true)
  if grep -q "Could not load members" <<<"$members_page"; then
    smoke_ok=false; fail "http://cms.local/members shows 'Could not load members' (web can't reach members-service; check MEMBERS_API_URL and kubectl logs deploy/web-web)"
  elif grep -qE "<table|No members yet" <<<"$members_page"; then
    ok "http://cms.local/members loads the member list"
  else
    smoke_ok=false; fail "http://cms.local/members returned an error status or no member list"
  fi
else
  warn "skipping HTTP checks until the tunnel and /etc/hosts are fixed (see above)"
fi

# Prometheus, Loki and Tempo have no Ingress; reach them through temporary port-forwards.
# If something else already listens on the port (often your own port-forward from
# the runbook, maybe to an older cluster), kubectl can't bind it, and the checks
# below would quietly query whatever that is. So refuse, and say why.
# port_free <port> — true when nothing answers on localhost:<port>.
port_free() { ! (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
for port in 9090 3100 3200 13001; do
  if ! port_free "$port"; then
    smoke_ok=false
    fail "localhost:$port is already in use (an old port-forward? find it: lsof -i :$port). The Prometheus/Loki/Tempo checks below would query it instead of this cluster"
  fi
done
kubectl -n monitoring port-forward svc/kube-prometheus-stack-prometheus 9090 >/dev/null 2>&1 &
pf_pid=$!
kubectl -n monitoring port-forward svc/loki 3100 >/dev/null 2>&1 &
loki_pf_pid=$!
kubectl -n monitoring port-forward svc/tempo 3200 >/dev/null 2>&1 &
tempo_pf_pid=$!
# members-service directly (not through Traefik), so the trace check below works
# without the tunnel. 13001, not 3001: that is `pnpm dev`'s port.
kubectl port-forward svc/members-service-members-service 13001:3001 >/dev/null 2>&1 &
members_pf_pid=$!
trap 'kill $pf_pid $loki_pf_pid $tempo_pf_pid $members_pf_pid 2>/dev/null || true' EXIT
# targets_up <job> — true once Prometheus scrapes both Pods of that service.
targets_up() {
  curl -s 'http://localhost:9090/api/v1/targets?state=active' \
    | jq -e --arg job "$1" '[.data.activeTargets[] | select(.labels.job == $job and .health == "up")] | length >= 2'
}
# A new ServiceMonitor takes the Operator ~1 minute to pick up (observability.md troubleshooting).
for job in members-service events-service; do
  if wait_for 180 "$job targets up in Prometheus" targets_up "$job"; then
    ok "Prometheus scrapes $job (2 pods up)"
  else
    smoke_ok=false
  fi
done

# The whole log path in one check: a members-service line in Loki means Alloy found
# the Pod, read its log file, labelled it (namespace/app), and Loki stored it.
# Any members-service line will do: the service logs at startup and on every request.
# loki_has_logs — true once Loki returns at least one line from the last 15 minutes.
loki_has_logs() {
  curl -s -G 'http://localhost:3100/loki/api/v1/query_range' \
    --data-urlencode 'query={namespace="default", app="members-service"}' \
    --data-urlencode "start=$(( $(date +%s) - 900 ))000000000" \
    --data-urlencode 'limit=1' \
    | jq -e '[.data.result[].values[]] | length >= 1'
}
if wait_for 60 "members-service logs in Loki" loki_has_logs; then
  ok "Loki has members-service logs (Alloy → Loki works)"
else
  smoke_ok=false
  fail "no members-service logs in Loki: check kubectl -n monitoring logs ds/alloy (docs/observability.md troubleshooting)"
fi

# The whole trace path in one check: send members-service one request carrying
# a traceparent we made up, then ask Tempo for that trace id. Finding it means
# the SDK made spans, exported them to the Collector, and the Collector forwarded
# them to Tempo. (Health probes are not traced on purpose, so a real API call.)
# The request is retried inside the loop: the port-forward needs a moment to start.
trace_id=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
# tempo_has_trace — true once Tempo returns the trace we started.
tempo_has_trace() {
  curl -s -m 5 -o /dev/null -H "traceparent: 00-$trace_id-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')-01" \
    'http://localhost:13001/members?limit=1' || true
  curl -sf -m 5 "http://localhost:3200/api/traces/$trace_id" | jq -e '(.batches // .resourceSpans // []) | length >= 1' >/dev/null
}
if wait_for 90 "a members-service trace in Tempo" tempo_has_trace; then
  ok "Tempo has trace $trace_id (app → OTel Collector → Tempo works)"
else
  smoke_ok=false
  fail "no trace in Tempo: check kubectl -n monitoring logs deploy/otel-collector, then the app's OTEL_* env (docs/observability.md troubleshooting)"
fi

# Each service creates its durable consumer on the OTHER service's stream when it
# connects (ADR-0010). Both existing means both services reached NATS.
# consumer_exists <stream> <durable>
consumer_exists() {
  kubectl exec -n nats deploy/nats-box -- nats consumer info "$1" "$2" >/dev/null 2>&1
}
for pair in "MEMBERS events-service" "EVENTS members-service"; do
  read -r stream durable <<<"$pair"
  if wait_for 60 "consumer $durable on stream $stream" consumer_exists "$stream" "$durable"; then
    ok "NATS: $durable consumes from $stream"
  else
    smoke_ok=false
  fi
done

# --- Summary -----------------------------------------------------------------
step "done" "Finished in ${SECONDS}s"
cat <<EOF
    App                http://cms.local
    Members API        http://cms.local/api/members/members
    Events API         http://cms.local/api/events/events
    Traefik dashboard  http://traefik.cms.local/dashboard/
    Grafana            http://grafana.cms.local/d/cms-service-red   (user: admin)
    Grafana password   kubectl get secret -n monitoring -l app.kubernetes.io/component=admin-secret \\
                         -o jsonpath="{.items[0].data.admin-password}" | base64 --decode; echo
    Prometheus         kubectl -n monitoring port-forward svc/kube-prometheus-stack-prometheus 9090
    Logs (Loki)        Grafana → Explore → Loki, e.g. {app="members-service"} | json
    Traces (Tempo)     Grafana → Explore → Tempo, e.g. { resource.service.name = "members-service" }

    Next: send some traffic and watch the dashboard — docs/observability.md, exercises.
EOF
if $network_ok && $smoke_ok; then
  ok "everything is up and verified"
else
  fail "some checks failed — see the ✘ lines above"
  exit 1
fi
