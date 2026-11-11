#!/usr/bin/env bash
# Ask Prometheus, Loki or Tempo a question from the terminal, without the tunnel,
# a port-forward or a browser.
#
#   scripts/obs-query.sh prom  '<PromQL>'          # instant query: one line per series
#   scripts/obs-query.sh loki  '<LogQL>' [since]   # lines (or a metric query's values); since: 1h by default
#   scripts/obs-query.sh tempo '<TraceQL>' [since] # matching traces: root service, root span, duration
#   scripts/obs-query.sh tempo-trace <trace id>    # the span names of one trace
#
#   scripts/obs-query.sh prom 'sum by (reason) (members_registration_failures_total)'
#   scripts/obs-query.sh loki '{app="members-service"} | json | level="error"' 30m
#   scripts/obs-query.sh tempo '{ resource.service.name = "members-service" && status = error }'
#
# How it gets there: `kubectl get --raw` calls the Kubernetes API server, whose
# SERVICE PROXY (/api/v1/namespaces/<ns>/services/<svc>:<port>/proxy/<path>) forwards
# the request to a Service inside the cluster. So it works whenever kubectl does:
# no `minikube tunnel`, no /etc/hosts entry, and no port-forward to start and race.
# (Exec-ing into the Pods doesn't work: the Prometheus image has no wget or curl.)
#
# Written during the CMS-31 retro: the session that built the SLO rules queried these
# APIs ~40 times through throwaway helpers. Runbook: docs/observability.md.
set -euo pipefail

NS=monitoring
PROM=kube-prometheus-stack-prometheus:9090
LOKI=loki:3100
TEMPO=tempo:3200

usage() { sed -n '5,8p' "$0" | sed 's/^# //' >&2; exit 2; }
(($# >= 2)) || usage

# URL-encode one argument (PromQL/LogQL are full of {}, ", |, spaces).
enc() { jq -rn --arg v "$1" '$v|@uri'; }

proxy() {   # proxy <service:port> <path-and-query>
  # On an HTTP error (a 400 for a query with a syntax error) kubectl only says "the
  # server rejected our request", so say which way to look.
  kubectl get --raw "/api/v1/namespaces/$NS/services/$1/proxy/$2" ||
    { echo "obs-query: ${1%%:*} rejected the request: check the query's syntax (or is the Service up?)" >&2; exit 1; }
}

# "1h" / "30m" / "45s" → seconds, for the start of a range.
seconds() {
  local n=${1%[smhd]} u=${1: -1}
  case $u in s) echo "$n" ;; m) echo $((n * 60)) ;; h) echo $((n * 3600)) ;; d) echo $((n * 86400)) ;; *) echo "$1" ;; esac
}

kind=$1 query=$2 since=${3:-1h}
case $kind in
  prom)
    # Instant query: the value of each series right now. `{labels} value` per line,
    # without __name__ (it's in the query anyway).
    proxy "$PROM" "api/v1/query?query=$(enc "$query")" |
      jq -r 'if .status != "success" then "error: \(.error)" else
               (.data.result[] | "\(.metric | del(.__name__) | tojson) \(.value[1])") end'
    ;;
  loki)
    end=$(date +%s)
    start=$((end - $(seconds "$since")))
    # query_range answers both kinds of LogQL: a log query returns lines ("streams"),
    # a metric query (count_over_time, rate, ...) returns values ("matrix"). For a
    # matrix, the last value of each series is printed.
    proxy "$LOKI" "loki/api/v1/query_range?query=$(enc "$query")&start=${start}000000000&end=${end}000000000&limit=50" |
      jq -r 'if .status != "success" then "error: \(.error // .)" else .data |
               if .resultType == "streams" then (.result[] | .values[] | .[1])
               else (.result[] | "\(.metric | tojson) \(.values[-1][1])") end end'
    ;;
  tempo)
    end=$(date +%s)
    start=$((end - $(seconds "$since")))
    proxy "$TEMPO" "api/search?q=$(enc "$query")&start=$start&end=$end&limit=20" |
      jq -r '.traces[]? | "\(.traceID)  \(.rootServiceName)  \(.rootTraceName)  \(.durationMs // 0) ms"'
    ;;
  tempo-trace)
    # Tempo returns OTLP JSON: one batch per service, each with its spans.
    proxy "$TEMPO" "api/traces/$query" |
      jq -r '.batches[] | (.resource.attributes[] | select(.key == "service.name") | .value.stringValue) as $svc
             | (.scopeSpans // .instrumentationLibrarySpans)[] | .spans[] | "\($svc)  \(.name)"'
    ;;
  *) usage ;;
esac
