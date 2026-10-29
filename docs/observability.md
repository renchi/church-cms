# Observability Runbook — Prometheus, Grafana, Loki, Tempo: metrics, logs and traces

How to install the monitoring stack on minikube, see the services' metrics in Grafana,
search every Pod's logs in Grafana through Loki, and follow one request across every
service as a trace in Tempo. **Concepts first?** Read
[study-guide §9](study-guide.md#9-observability-roadmap-stage-7) (logs: §9.9; traces: §13).
**Why this design?** See [ADR-0009](adr/0009-observability-opentelemetry.md).

What you end up with:

```
members-service Pod                         monitoring namespace
┌─────────────────────────────┐             ┌──────────────────────────────────┐
│ :3001  API (Fastify)        │             │ Prometheus Operator               │
│   └─ OTel SDK measures each │             │   reads ServiceMonitors ──────┐   │
│      request               │   scrape    │                               ▼   │
│ :9464  /metrics (exporter) ◄─────────────── Prometheus (stores series)        │
│                             │  every 15s  │         ▲                         │
│ stdout: JSON logs           │             │ Grafana ┘  http://grafana.cms.local│
└──────────┬──────────────────┘             │    ▲ LogQL                        │
           │ container runtime writes        │    │                              │
           ▼ /var/log/pods/... on the node   │  Loki (stores lines, 7 days)      │
   Alloy (DaemonSet) tails the files ─push──►    ▲                              │
           + Kubernetes events               └────┴─────────────────────────────┘
```

Prerequisites: the cluster from [`k8s-local-dev.md`](k8s-local-dev.md) is running
(minikube, Traefik, members-service), and `minikube tunnel` is open.

> **Shortcut:** [`scripts/cluster-up.sh`](../scripts/cluster-up.sh) runs steps 1–3, 7–8 and 10–11 below (and the
> whole k8s runbook), keeps `grafana.cms.local` in `/etc/hosts` up to date for step 4, and checks
> steps 5, 8 and 11 for you. Read on to learn what it does.

---

## 1. Enable metrics-server

```bash
minikube addons enable metrics-server
# * The 'metrics-server' addon is enabled
```

> **What this does:** metrics-server collects live CPU/memory per Pod. It feeds
> `kubectl top` and the **HorizontalPodAutoscaler**, *not* Grafana. Without it, the
> members-service HPA can't read CPU and never scales. Prometheus is a separate system;
> see study-guide §9.7.

Check after a minute:

```bash
kubectl top pods
# NAME                                               CPU(cores)   MEMORY(bytes)
# members-service-members-service-7c69959bfd-c4q4c   39m          31Mi
kubectl get hpa
# ... TARGETS cpu: 2%/70%   (not <unknown>; brand-new Pods may show <unknown> for a few minutes)
```

## 2. Install kube-prometheus-stack

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update prometheus-community

helm upgrade --install kube-prometheus-stack prometheus-community/kube-prometheus-stack \
  --version 92.2.0 \
  -n monitoring --create-namespace \
  -f k8s/monitoring/kube-prometheus-stack-values.yaml \
  --wait --timeout 8m
# takes ~1–2 minutes the first time

kubectl -n monitoring get pods
# alertmanager-kube-prometheus-stack-alertmanager-0          2/2   Running
# kube-prometheus-stack-grafana-...                          3/3   Running
# kube-prometheus-stack-kube-state-metrics-...               1/1   Running
# kube-prometheus-stack-operator-...                         1/1   Running
# kube-prometheus-stack-prometheus-node-exporter-...         1/1   Running
# prometheus-kube-prometheus-stack-prometheus-0              2/2   Running
```

> **What `--version` does:** pins the chart, so a reinstall months from now gives the
> same result. The values file explains every setting we change.

This must happen **before** the Deploy workflow next runs: deploy.yml installs
members-service with `metrics.serviceMonitor.enabled=true`, and that fails if the
`ServiceMonitor` CRD (installed by this chart) doesn't exist yet.

## 3. Add the dashboard

```bash
kubectl apply -f k8s/monitoring/service-red-dashboard.yaml
# configmap/cms-service-red-dashboard created
```

Grafana's sidecar notices the ConfigMap's `grafana_dashboard: "1"` label and loads it
within a few seconds. No restart is needed.

## 4. Reach Grafana in the browser

Find the address Traefik serves on (the same one `cms.local` uses):

```bash
kubectl -n monitoring get ingress
# NAME                            CLASS     HOSTS               ADDRESS          PORTS
# kube-prometheus-stack-grafana   traefik   grafana.cms.local   10.109.105.150   80
```

Add `grafana.cms.local` to `/etc/hosts` with **that** address. On this machine it's
Traefik's LoadBalancer IP, not `127.0.0.1`:

```bash
echo "10.109.105.150  grafana.cms.local" | sudo tee -a /etc/hosts
```

Then log in:

```bash
# user: admin   password:
kubectl get secret -n monitoring -l app.kubernetes.io/component=admin-secret \
  -o jsonpath="{.items[0].data.admin-password}" | base64 --decode; echo
```

Open <http://grafana.cms.local> → **Dashboards** → **CMS — Service RED metrics**.

> **Can't reach it?** `curl -H 'Host: grafana.cms.local' http://<ADDRESS>/login` should
> return 200. If it does, the problem is `/etc/hosts`. If it doesn't, check that
> `minikube tunnel` is running.

## 5. Check Prometheus is scraping the service

Prometheus has no Ingress. Port-forward it when you need it:

```bash
kubectl -n monitoring port-forward svc/kube-prometheus-stack-prometheus 9090
# open http://localhost:9090 → Status → Targets → search "members"
# serviceMonitor/default/members-service-members-service/0   2/2 up
```

## 6. Read one Pod's logs (`kubectl logs`)

```bash
kubectl logs deploy/members-service-members-service --tail=5
# {"level":"info","time":...,"service":"members-service","reqId":"req-e","req":{"method":"GET","url":"/members",...},"msg":"incoming request"}
# {"level":"info","time":...,"service":"members-service","reqId":"req-e","res":{"statusCode":200},"responseTime":1.47,"msg":"request completed"}
```

One JSON object per line. `level` is a word (`info`, `warn`, `error`; pino's numbers 30/40/50
before CMS-28). `reqId` ties a request's lines together. `/health` probes are deliberately
not logged.

To turn on debug logs: `helm upgrade ... --set config.logLevel=debug` (it's in the
ConfigMap), or edit `charts/members-service/values.yaml`.

`kubectl logs` reads **one Pod**, and only while it exists. For every Pod at once,
including deleted ones, use Loki (steps 7–9).

## 7. Install Loki (the log store)

```bash
# Since March 2026 the open-source Loki chart lives in grafana-community,
# not grafana (that one is for Grafana Enterprise Logs).
helm repo add grafana-community https://grafana-community.github.io/helm-charts
helm repo update grafana-community

helm upgrade --install loki grafana-community/loki \
  --version 18.15.0 \
  -n monitoring \
  -f k8s/monitoring/loki-values.yaml \
  --wait --timeout 5m

kubectl -n monitoring get pods,pvc -l app.kubernetes.io/name=loki
# pod/loki-0                         1/1   Running
# persistentvolumeclaim/storage-loki-0   Bound   ...   2Gi
```

> **What this does:** one Loki process (monolithic mode) with its index and chunks on a
> 2 Gi PersistentVolume, deleting lines older than 7 days. No gateway: Alloy and Grafana
> talk to the `loki` Service on port 3100. Every setting is explained in
> [`loki-values.yaml`](../k8s/monitoring/loki-values.yaml).

Grafana already knows Loki: the data source is in
[`kube-prometheus-stack-values.yaml`](../k8s/monitoring/kube-prometheus-stack-values.yaml)
(`additionalDataSources`, uid `loki`), so step 2 must have run with the current values.

## 8. Install Alloy (the agent that ships logs)

```bash
helm repo add grafana https://grafana.github.io/helm-charts
helm repo update grafana

helm upgrade --install alloy grafana/alloy \
  --version 1.13.1 \
  -n monitoring \
  -f k8s/monitoring/alloy-values.yaml \
  --wait --timeout 3m

kubectl -n monitoring get ds alloy
# NAME    DESIRED   CURRENT   READY   ...
# alloy   1         1         1              ← one per node; minikube has one node
```

> **What this does:** a DaemonSet, so one Alloy Pod per node. It asks Kubernetes which
> Pods run on its node, tails their files under `/var/log/pods`, keeps four labels
> (`namespace`, `pod`, `container`, `app`), and pushes the lines to Loki. It also
> forwards Kubernetes events (`job="kubernetes-events"`). The pipeline is commented
> block by block in [`alloy-values.yaml`](../k8s/monitoring/alloy-values.yaml).

Check the whole path end to end, the same check `cluster-up.sh` makes:

```bash
kubectl -n monitoring port-forward svc/loki 3100 &
curl -s http://localhost:3100/loki/api/v1/labels | jq -c .data
# ["__stream_shard__","app","container","instance","job","namespace","pod","service_name"]
#   our four, plus: job/instance (on the Kubernetes-events streams only), service_name
#   (Loki copies it from `app`), __stream_shard__ (Loki-internal)
curl -s http://localhost:3100/loki/api/v1/label/app/values | jq -c .data
# ["alertmanager","alloy","events-postgres","events-service","grafana",...,"members-service","nats","traefik","web"]
```

Or in the browser: Grafana → **Explore** → data source **Loki** →
`{app="members-service"} | json` → Run query.

## 9. LogQL cheat sheet (our fields)

A query always starts with a **stream selector** in `{}`. Only labels go there:
`namespace`, `pod`, `container`, `app`. Everything else is a field inside the JSON line,
which `| json` extracts.

| Want | Query |
| --- | --- |
| Everything from one service | `{app="members-service"}` |
| Several apps | `{namespace="default", app=~"members-service\|web"}` |
| Lines containing a text (fast scan) | `{app="members-service"} \|= "member registered"` |
| …not containing | `{app="web"} != "GET /_next"` |
| Only warnings and errors | `{app="events-service"} \| json \| level=~"warn\|error\|fatal"` |
| …plus lines that aren't JSON (stack traces, plain-text library output); the dashboard's panel uses this | `{app="events-service", container!="migrate"} \| json \| level=~"warn\|error\|fatal" or __error__!=""` |
| One request's lines (one service) | `{app="members-service"} \| json \| reqId="req-15"` |
| Failed requests | `{app="members-service"} \| json \| res_statusCode >= 400` (nested `res.statusCode` becomes `res_statusCode`) |
| Slow requests | `{app="members-service"} \| json \| responseTime > 100` |
| Everything about one member, across services | `{namespace=~"default\|traefik"} \|= "<memberId>"` |
| Failed registrations | `{app="web"} \| json \| msg="registration failed"` |
| Browser requests that failed | `{app="traefik"} \| json \| DownstreamStatus >= 400` |
| Show only some fields | `{app="web"} \| json \| line_format "{{.status}} {{.msg}}"` |
| Kubernetes events | `{job="kubernetes-events"} \| json \| reason=~"Killing\|Unhealthy\|BackOff\|OOMKilled"` |
| Postgres (plain text, not JSON) | `{app="members-postgres"} \|~ "FATAL\|ERROR"` |
| **Metric:** registrations per minute by status | `sum by (status) (count_over_time({app="web"} \| json \| msg=~"registration (succeeded\|failed)" [1m]))` |
| **Metric:** error lines per second, per service | `sum by (app) (rate({namespace="default"} \| json \| level="error" [1m]))` |

Rules of thumb: put as much as you can in the `{}` selector (that's the index), use `|=`
before `| json` when you can (a text scan is cheaper than parsing), and never filter on a
field that should have been a label, or vice versa (study-guide §9.9: cardinality).

## 10. Install Tempo (the trace store)

Traces are the third signal (CMS-29, [study-guide §13](study-guide.md#13-distributed-tracing-cms-29)).
The path a span takes:

```
web / members-service / events-service ──OTLP/HTTP :4318──► OTel Collector ──OTLP/gRPC :4317──► Tempo
          (spans, pushed in batches)                        │  batch, memory_limiter                 ▲
                                                            └─ span_metrics ─► :8889 ◄─scrape─ Prometheus
                                                                                      Grafana ┘ (TraceQL, port 3200)
```

```bash
# The Tempo chart moved to grafana-community, like Loki's (§7).
helm repo add grafana-community https://grafana-community.github.io/helm-charts
helm repo update grafana-community

helm upgrade --install tempo grafana-community/tempo \
  --version 3.2.0 \
  -n monitoring \
  -f k8s/monitoring/tempo-values.yaml \
  --wait --timeout 5m

kubectl -n monitoring get pods,pvc -l app.kubernetes.io/name=tempo
# pod/tempo-0                           1/1   Running
# persistentvolumeclaim/storage-tempo-0   Bound   ...   2Gi
```

> **What this does:** Tempo in single-binary mode (one Pod does receiving, storing,
> compacting and querying), with traces on a 2 Gi PersistentVolume, deleted after 24h.
> Grafana already has it as a data source (uid `tempo`, in
> [`kube-prometheus-stack-values.yaml`](../k8s/monitoring/kube-prometheus-stack-values.yaml)),
> so step 2 must have run with the current values. That same upgrade turns on
> Prometheus's `exemplar-storage` and the links between Loki and Tempo.

## 11. Install the OpenTelemetry Collector (the apps' trace pipeline)

```bash
helm repo add open-telemetry https://open-telemetry.github.io/opentelemetry-helm-charts
helm repo update open-telemetry

helm upgrade --install otel-collector open-telemetry/opentelemetry-collector \
  --version 0.176.0 \
  -n monitoring \
  -f k8s/monitoring/otel-collector-values.yaml \
  --wait --timeout 3m

kubectl -n monitoring logs deploy/otel-collector | grep -E 'Everything is ready|error'
# ... info  service@v0.162.0/service.go:256  Everything is ready. Begin running and processing data.
```

> **What this does:** one Collector Pod, reachable as
> `otel-collector.monitoring.svc.cluster.local` (`fullnameOverride`). It receives OTLP on
> 4317/4318, drops data when near its memory limit (`memory_limiter`), batches, and sends
> traces to Tempo. The `span_metrics` connector also turns every span into a latency
> histogram with trace-id **exemplars**, served on :8889 for Prometheus (a ServiceMonitor
> in the same chart). The pipeline is commented block by block in
> [`otel-collector-values.yaml`](../k8s/monitoring/otel-collector-values.yaml).

Then turn tracing on in the apps. It's off by default in every chart; Deploy and
`cluster-up.sh` pass the endpoint:

```bash
helm upgrade members-service ./charts/members-service --reuse-values \
  --set tracing.otlpEndpoint=http://otel-collector.monitoring.svc.cluster.local:4318
kubectl get cm members-service-members-service-config -o yaml | grep OTEL_
#   OTEL_EXPORTER_OTLP_ENDPOINT: http://otel-collector.monitoring.svc.cluster.local:4318
#   OTEL_TRACES_EXPORTER: otlp
```

Check the whole path end to end, the same check `cluster-up.sh` makes: send a request
with a trace id you made up, then ask Tempo for it.

```bash
kubectl -n monitoring port-forward svc/tempo 3200 &
TRACE=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
curl -s -o /dev/null -H "traceparent: 00-$TRACE-00f067aa0ba902b7-01" http://cms.local/api/members/members
sleep 10  # measured: ~10 s. The SDK exports every 5 s, the Collector batches up to 2 s, then Tempo ingests
curl -s http://localhost:3200/api/traces/$TRACE | jq -c '[.. | .name? // empty | strings] | unique'
# ["@cms/events","@fastify/otel","@opentelemetry/instrumentation-http","GET /members",
#  "handler - memberRoutes","prisma:Member.count","prisma:Member.findMany","request"]
#   the span names, plus the names of the libraries that made them (instrumentation scopes)
```

## 12. Following a trace (TraceQL cheat sheet)

In Grafana → **Explore** → data source **Tempo** → *Search* (a form) or *TraceQL* (a query).
A TraceQL query selects **spans** with conditions in `{}` and returns the traces that
contain them. `resource.` attributes describe the process (which service), `span.`
attributes describe the operation, and `name`, `status`, `duration`, `kind` are intrinsic.

| Want | TraceQL |
| --- | --- |
| Everything from one service | `{ resource.service.name = "members-service" }` |
| Failed anything | `{ status = error }` |
| Failed registrations (the 409 too) | `{ name = "RegisterMemberUseCase" && status = error }` |
| Slow requests | `{ kind = server && duration > 200ms }` |
| An archive that reached events-service | `{ name = "publish cms.members.archived" } >> { resource.service.name = "events-service" }` (`>>`: a descendant) |
| Messages processed after a retry | `{ kind = consumer && span.messaging.nats.delivery_count > 1 }` |
| One query type | `{ name = "prisma:Member.create" }` |
| One outbox message, by id | `{ span.messaging.message.id = "<outbox row id>" }` |
| One trace | paste the trace id into the search box |

Moving between the three signals:

| From | To | How |
| --- | --- | --- |
| a log line in Loki | its trace | expand the line → **View trace** (the `trace_id` field, `derivedFields`) |
| a span in Tempo | its logs | the span's **Logs for this span** button (`tracesToLogsV2`) |
| a dot on *Duration from traces* | that request's trace | hover the exemplar → **View trace** |
| a trace id from anywhere | Loki | `{namespace="default"} \|= "<trace id>"` |

---

## Troubleshooting

| Symptom | Cause → fix |
| --- | --- |
| `helm upgrade members-service` fails with *no matches for kind "ServiceMonitor"* | The monitoring stack isn't installed, so the CRD is missing. Do step 2 first |
| Target missing from Prometheus → Targets | The Operator needs ~1 minute to reload after a new ServiceMonitor. Still missing? The ServiceMonitor needs the label `release: kube-prometheus-stack`: `kubectl get servicemonitor -A --show-labels` |
| Target **DOWN**, `connection refused` | The Pod isn't serving :9464. The container must start with `node --import ./dist/instrumentation.js` (Dockerfile `CMD`), and the Service needs a port named `metrics` |
| Dashboard panels say **No data** (but "Pods scraped" shows 2) | **No traffic since the Pods started.** Counters live in each Pod's memory and restart from zero on every deploy or restart; until the first request, the request metric doesn't exist at all. Send some requests (exercise 3), then wait ~1 minute: `rate()` needs at least two scrapes |
| Errors panel stays at **0** right after the first errors | The 404/400 series didn't exist until those requests, so Prometheus's first sample already holds the full count and `rate()` sees no increase. Send a few more; from then on it's counted. See study-guide §9.8 |
| A series with an empty route | Requests that matched no route (e.g. 404 on an unknown path) have no `http_route`. That's expected |
| `kubectl get hpa` shows `<unknown>` | metrics-server not enabled (step 1), or the Pods are only a few minutes old |
| Prometheus alerts firing about etcd/scheduler | These are disabled in our values file because minikube doesn't expose them. Re-run step 2 if you installed with defaults |
| **No logs in Loki** at all | Read Alloy's own logs: `kubectl -n monitoring logs ds/alloy -c alloy \| grep -i error`. `forbidden` → RBAC (the chart creates it; was `rbac.create` turned off?). `no such file` / nothing tailed → the paths: on the docker runtime `/var/log/pods/*/0.log` are symlinks into `/var/lib/docker/containers`, so `alloy.mounts.dockercontainers: true` is needed too. Open Alloy's UI (`kubectl -n monitoring port-forward ds/alloy 12345` → <http://localhost:12345>) to see each component's health and targets |
| Lines arrive but look like `{"log":"{\"level\"...","stream":"stdout"}` | The runtime's envelope wasn't unwrapped: `stage.docker` for the docker runtime, `stage.cri` for containerd/CRI-O. Check with `minikube ssh -- sudo head -c 300 /var/log/pods/<pod>/<container>/0.log` |
| A changed `alloy-values.yaml` seems to have no effect | A ConfigMap mounted as a volume reaches the Pod up to ~1 minute later; then the config-reloader sidecar reloads Alloy. Check `kubectl -n monitoring logs ds/alloy -c config-reloader` for `Reload triggered` before testing |
| Grafana: `{app="web"}` finds nothing, but `{app="web-web"}` does | Lines from web Pods started before the chart added `app.kubernetes.io/name: web` (the fallback label is `app: web-web`). They age out after 7 days |
| `\| json` shows `__error__="JSONParserErr"` | That line isn't JSON: Postgres, NATS and the migrate init container log plain text. Filter with `\|=` / `\|~` instead, or add `\| __error__=""` to drop the lines that failed to parse |
| Loki refuses lines: `maximum active stream limit exceeded` / too many streams | A label with too many values (a per-request id, a timestamp, a file path that changes). `curl -s localhost:3100/loki/api/v1/labels` and look at each label's values; move the culprit into the line. Alloy drops `filename` and `stream` for this reason |
| Each Kubernetes event appears **twice** (or N times) | More than one node: every Alloy Pod watches the whole cluster's events. Move `loki.source.kubernetes_events` into a separate one-replica Alloy Deployment, or enable Alloy clustering |
| Grafana answers `503 no available server` / its probes time out | Grafana at its memory limit spends its CPU on garbage collection (`kubectl -n monitoring top pod -l app.kubernetes.io/name=grafana --containers`: memory at the limit, CPU high). The limit is 512Mi since CMS-28 |
| **No traces in Tempo** at all | Work outward from the app. (1) Is tracing on? `kubectl get cm members-service-members-service-config -o yaml \| grep OTEL_` must show `otlp` and the endpoint; without them the SDK exports to `none`. (2) Does the Collector receive? `kubectl -n monitoring logs deploy/otel-collector \| grep -i error`: `connection refused` to `tempo...:4317` means Tempo is down. (3) Remember the delays: the SDK batches for ~5 s and the Collector for 2 s, so wait ~10 s before searching |
| The app logs `could not send the last trace spans before exiting` | The Collector was unreachable when the Pod stopped; the flush gave up after 3 s instead of delaying shutdown. Harmless, but check the Collector if it repeats |
| Every API call returns `502`; the service logs `TypeError: parentTracer.getSpanLimits is not a function` | A tracing library built for the 1.x OTel SDK, running against our 2.x SDK (it happened with `@prisma/instrumentation` 5.22, study-guide §13.4). Check every OTel-related package's own `dependencies` against the SDK version |
| **The trace breaks at NATS**: the events-service spans are a separate trace | The `traceparent` header didn't make it. Read the stored message: `kubectl exec -n nats deploy/nats-box -- nats stream get MEMBERS --last-for cms.members.archived`; the headers must include `traceparent`. No header → `jetStreamPublisher` (`packages/events/src/nats.ts`) isn't sending it. An empty `traceparent` column on the outbox row → the row was written while tracing was off |
| **The trace breaks at web**: web and members-service are separate traces | web's `fetch` sends `traceparent` only to `propagateContextUrls` (`apps/web/instrumentation.ts`). If `MEMBERS_API_URL` changed, the allow-list follows it automatically; anything else must be added |
| **Orphan spans**: a span whose parent is "missing" in the waterfall | The parent span was never exported: its process crashed or was killed before its batch went out, or it was sampled out. Check that service's restarts (`kubectl get pods`) |
| Thousands of tiny traces named `prisma:OutboxMessage.findMany` | The relay's poll loop is being traced. The shared sampler (`packages/events/src/sampling.ts`) drops database spans with no parent; was the `prisma:` span name prefix changed? |
| No exemplar dots on *Duration from traces* | Prometheus needs `enableFeatures: [exemplar-storage]` (step 2 values; the Prometheus Pod restarts to pick it up), and the panel's query needs the *Exemplars* toggle on. Check that Prometheus scrapes the Collector: Targets → `otel-collector` |
| Collector logs `"spanmetrics" alias is deprecated` (or the chart rewrites `otlp` to `otlp_grpc`) | The Collector renamed components in 2026. Use the new names (`span_metrics`, `otlp_grpc`); the values file already does |

---

## Hands-on exercises

Do these with Grafana open on the RED dashboard (time range: last 15 minutes).

**1. Look at raw metrics.** Port-forward one Pod's metrics port and read what Prometheus
reads:

```bash
kubectl port-forward deploy/members-service-members-service 9464 &
curl -s http://cms.local/api/members/members >/dev/null
curl -s localhost:9464/metrics | grep 'http_server_request_duration_bucket.*"/members"'
```

*Expected:* 15 lines ending in `le="0.005"`, `le="0.01"` … `le="+Inf"`. The
counts only ever grow from left to right, because each bucket counts requests *at
most* that slow. Find the first bucket that contains your request: that's how fast
it was. (Kill the port-forward with `kill %1`.)

**2. Write a query yourself.** In Prometheus (step 5) → Graph, before looking at the
dashboard, write "requests per second to `/members` over the last minute".

*Expected:* `sum(rate(http_server_request_duration_count{http_route="/members"}[1m]))`.
Without `sum`, you get one line per Pod. Try it and see.

**3. Make errors.** Send bad requests and watch the Errors panel:

```bash
for i in $(seq 30); do
  curl -s -o /dev/null http://cms.local/api/members/members/no-such-id                    # 404
  curl -s -o /dev/null -X POST -H 'content-type: application/json' -d '{}' \
    http://cms.local/api/members/members                                                  # 400
done
```

*Expected:* 404 and 400 lines appear in "Errors — by status" within ~30s. (If these are the first 4xx since the Pods started, the first burst can read 0; run the loop once more. The troubleshooting table explains why.) The **5xx
error ratio** stays 0%. These are client errors, not ours. Why does that
distinction matter for paging someone at 3 a.m.?

**4. Kill a Pod.**

```bash
kubectl delete --wait=false $(kubectl get pod -l app.kubernetes.io/name=members-service -o name | head -1)
```

*Expected:* "Pods scraped (up)" briefly shows 1, then 2 again as the Deployment replaces
the Pod. In Prometheus → Targets, the new Pod appears by itself. The ServiceMonitor
follows the Service, not individual Pods.

**5. Load it and watch latency and the HPA.**

```bash
kubectl get hpa -w &      # leave running
kubectl run load --rm -it --image=busybox --restart=Never -- \
  sh -c 'while true; do wget -q -O- http://members-service-members-service:3001/members >/dev/null; done'
# Ctrl+C after ~2 minutes, then: kill %1
```

*Expected:* request rate jumps, p95/p99 rise, and CPU in `kubectl get hpa` climbs. If
it passes 70%, REPLICAS goes above 2 and "Pods scraped" follows. After you stop, the
HPA scales back down after ~5 minutes, which is its stabilisation window.

**6. Filter logs like a pro.**

```bash
kubectl logs deploy/members-service-members-service --tail=200 | jq -c 'select(.res.statusCode >= 400) | {reqId, status: .res.statusCode, ms: .responseTime}'
```

*Expected:* only the failed requests from exercise 3. This is why structured logs
matter: try writing that filter with `grep` against plain-text logs.

### Logs in Loki (CMS-28)

Do these in Grafana → **Explore** → **Loki**, time range "Last 15 minutes". Click a line
to see its parsed fields.

**7. Follow one registration by `reqId`, then by `memberId`.** Register a member at
<http://cms.local/members/new>. Copy the `registered=` id from the URL you land on.

```logql
{app="members-service"} |= "member registered" | json
```

Open the newest line, copy its `reqId` (e.g. `req-15`), then:

```logql
{app="members-service"} | json | reqId="req-15"
```

*Expected:* that request's lines (`incoming request`, `member registered`, `request
completed`), but **only from one Pod**: the `reqId` counter is per process, and the other
replica has its own `req-15` for a different request. Now across services:

```logql
{namespace=~"default|traefik"} |= "<memberId>"
```

*Expected, oldest first (switch the sort order to ascending):* members-service
`member registered`; web `registration succeeded` (about a millisecond later); members-service
`GET /members/<id>` (the list page looking up the name for its banner); Traefik
`"RequestPath":"/members?registered=<id>"`, the browser following the redirect. Four
hops, one query. Why couldn't `reqId` do this? (study-guide §9.9.)

**8. Find failed registrations.** Register the same email twice, then:

```logql
{app="web"} | json | msg="registration failed"
```

*Expected:* a `warn` line with `"status":409`. Notice what is **not** in it: the name and
email you typed. Where else could you look to find *which* email it was, and should you be
able to?

**9. Graph registrations from logs, and compare with Prometheus.** In Explore, switch the
query type to a metric query:

```logql
sum by (status) (count_over_time({app="web"} | json | msg=~"registration (succeeded|failed)" [1m]))
```

*Expected:* a graph with one line per status (`201`, `409`, ...). Now in a second Explore
pane, on Prometheus:

```promql
sum by (http_response_status_code) (increase(http_server_request_duration_count{job="members-service", http_route="/members", http_request_method="POST"}[1m]))
```

*Expected:* the same counts, give or take a minute's alignment. Then look at the RED
dashboard's p95 for `POST /members`. Which question can only the logs answer, and which
only the metrics? (Logs: *which* member. Metrics: *how slow*, cheaply, forever.)

**10. Kill a Pod and still read its logs.**

```bash
pod=$(kubectl get pod -l app.kubernetes.io/name=members-service -o name | head -1 | cut -d/ -f2)
kubectl delete pod "$pod"
kubectl logs "$pod"
# error: ... pods "members-service-members-service-..." not found
```

```logql
{pod="<that pod name>"}
{job="kubernetes-events"} |= "<that pod name>"
```

*Expected:* its last lines are all there, and the events show the deletion
(`"reason":"Killing"`, `"msg":"Stopping container members-service"`), followed by the
replacement Pod being scheduled and started.

**11. Break Postgres and find the cause in one view.**

```bash
kubectl scale deploy/members-postgres --replicas=0
# register a member in the browser: the form says it couldn't reach the service
kubectl scale deploy/members-postgres --replicas=1
```

```logql
{namespace="default", app=~"members-service|members-postgres|web"} |~ "(?i)error|fail|shutdown|ready to accept"
```

*Expected, in time order:* Postgres `received fast shutdown request` and `terminating
connection`; then members-service `PrismaClientKnownRequestError: Can't reach database server`
**every 500 ms** (the outbox relay's poll loop failing on each run, not your request);
then members-service's error for your `POST /members` and web's `registration failed`
with `"status":500` a few ms later; then Postgres `ready to accept connections`. The
cause (Postgres) and the effect (the 500) on one timeline, from three different apps.
Why does the relay's error repeat so often, and what would you change before a real
outage floods the logs?

### Traces in Tempo (CMS-29)

Grafana → Explore → **Tempo**, time range "last 15 minutes". Each exercise gives what you
should see; if it differs, the troubleshooting table above has the likely cause.

**12. Read a registration's waterfall.** Register a member in the browser
(<http://cms.local/members/new>), then search `{ resource.service.name = "web" }` and open
the newest trace.

*Expected:* one trace, spans from two services, in this order (measured, CMS-29):

```
0ms    web              POST /members/new                  49ms   ← the Server Action, the root
15ms   web              fetch POST http://members-service-members-service:3001/members
21ms   members-service  POST /members                      22ms
26ms   members-service  RegisterMemberUseCase              16ms
28ms   members-service  prisma:Member.findUnique            3ms   ← the duplicate-email check
36ms   members-service  prisma:Member.create                3ms
40ms   members-service  prisma:OutboxMessage.createMany     2ms
188ms  members-service  publish cms.members.registered      4ms   ← the relay, after the request ended
```

Find the slowest span. Then the gap: nothing happens between 49 ms and 188 ms. Why?
(The relay polls once a second, study-guide §11.) And why does the trace *end* at
`publish`? `MemberRegistered` has no consumer yet (CMS-27; Communications is CMS-20), so
nothing processes it. To see a trace cross NATS into events-service, archive the member:
press **Archive** next to them on <http://cms.local/members>, then search
`{ name = "ArchiveMemberUseCase" }` and open the newest trace. (Searching web's
`POST /members` alone also finds page renders: a Server Action posts to the page's own URL.)

*Expected:* the longest trace in the system, one click across three apps and the bus:
`POST /members` (**web**, the Archive button's Server Action, the root) → `fetch DELETE …/members/<id>`
→ `DELETE /members/:id` → `ArchiveMemberUseCase` → `prisma:Member.findUnique`, `prisma:Member.updateMany`,
`prisma:OutboxMessage.createMany` (members-service) → `publish cms.members.archived` (the relay) →
`process cms.members.archived` (**events-service**) → `DeclineAssignmentsForArchivedMemberUseCase` →
`prisma:ProcessedMessage.createMany`, `prisma:VolunteerAssignment.findMany`, all in one trace.
Measured (CMS-29 review), start times only:

```
0ms    web              POST /members                          ← the Archive button's Server Action, the root
9ms    web              fetch DELETE http://members-service-members-service:3001/members/<id>
11ms   members-service  DELETE /members/:id
12ms   members-service  ArchiveMemberUseCase
13ms   members-service  prisma:Member.findUnique
17ms   members-service  prisma:Member.updateMany
18ms   members-service  prisma:OutboxMessage.createMany
527ms  members-service  publish cms.members.archived          ← the relay's next poll
532ms  events-service   process cms.members.archived          ← 5 ms through NATS
534ms  events-service   DeclineAssignmentsForArchivedMemberUseCase
535ms  events-service   prisma:ProcessedMessage.createMany
537ms  events-service   prisma:VolunteerAssignment.findMany
```

**13. Find a failure without an id.** Register the same email twice. Then search
`{ status = error }`.

*Expected:* the second registration's trace, with `RegisterMemberUseCase` in red and the
error message "A member with this email already exists". The HTTP span is *not* red: a 409
is the client's error, and OTel only marks 5xx server spans. Expand the use-case span's
*Events* to see the recorded exception. Now press **Logs for this span**: Loki opens with
web's `registration failed` line and members-service's request lines, all carrying the
same `trace_id`.

**14. Break the trace on purpose.** In [`packages/events/src/nats.ts`](../packages/events/src/nats.ts),
comment out the line that copies the headers (`for (const [name, value] of Object.entries(traceHeaders)) headers.set(name, value);`),
redeploy (`scripts/cluster-up.sh --skip-build` won't do: the image must change, so run it
without `--skip-build`), and archive another member from <http://cms.local/members>.

*Expected:* the archive's trace now ends at `publish cms.members.archived`. The
`process cms.members.archived` span (events-service) is in a **trace of its own**, a root span
with no parent. Same work, same order, but nothing joins the two halves: that's what the header
carries. Search `{ name = "process cms.members.archived" }` to find the orphaned half.
(A registration shows nothing here: `MemberRegistered` has no consumer, so there is no second
half to orphan.) Undo the change and redeploy.

**15. Find a slow request from a graph.** Add a delay to the use case,
`await new Promise((r) => setTimeout(r, 300));` at the top of `RegisterMemberUseCase.execute`
(`apps/members-service/src/application/RegisterMemberUseCase.ts`), redeploy, and register a
few members. Open the RED dashboard's *Duration from traces* panel.

*Expected:* the `POST /members` line jumps above 300 ms, with **exemplar dots** on it.
Hover one → **View trace**: Tempo opens that exact request, and the waterfall shows a
~300 ms gap inside `RegisterMemberUseCase` with no child span in it. The time is *in the
code*, not in a query or a call: that's how a trace tells you where to look. Remove the
delay.

**16. Log → trace → log.** In Loki, run `{app="members-service"} |= "member registered"`,
expand a line, and press **View trace** next to `trace_id`.

*Expected:* Tempo opens the registration's trace (exercise 12). On the web span
`POST /members/new`, press **Logs for this span**: you land on web's `registration succeeded`
line. You went from one service's log line to another service's through the trace, with no
`memberId` and no search by hand. Repeat it with an archive (exercise 12's Archive button), starting
from events-service's span `process cms.members.archived`: its logs are events-service's
`message processed` line for that message.
