# Observability Runbook — Prometheus, Grafana, Loki: metrics and logs

How to install the monitoring stack on minikube, see the services' metrics in Grafana,
and search every Pod's logs in Grafana through Loki. **Concepts first?** Read
[study-guide §9](study-guide.md#9-observability-roadmap-stage-7) (logs: §9.9).
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

> **Shortcut:** [`scripts/cluster-up.sh`](../scripts/cluster-up.sh) runs steps 1–3 and 7–8 below (and the
> whole k8s runbook), keeps `grafana.cms.local` in `/etc/hosts` up to date for step 4, and checks
> steps 5 and 8 for you. Read on to learn what it does.

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
