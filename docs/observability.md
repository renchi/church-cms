# Observability Runbook — Prometheus, Grafana, metrics and logs

How to install the monitoring stack on minikube, see the services' metrics in Grafana,
and read their logs. **Concepts first?** Read [study-guide §9](study-guide.md#9-observability-roadmap-stage-7).
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
│ stdout: JSON logs ──► kubectl logs        │ Grafana ┘  http://grafana.cms.local│
└─────────────────────────────┘             └──────────────────────────────────┘
```

Prerequisites: the cluster from [`k8s-local-dev.md`](k8s-local-dev.md) is running
(minikube, Traefik, members-service), and `minikube tunnel` is open.

> **Shortcut:** [`scripts/cluster-up.sh`](../scripts/cluster-up.sh) runs steps 1–3 below (and the
> whole k8s runbook), then checks steps 4–5 for you. Read on to learn what it does.

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

## 6. Read the logs

```bash
kubectl logs deploy/members-service-members-service --tail=5
# {"level":30,"time":...,"service":"members-service","reqId":"req-e","req":{"method":"GET","url":"/members",...},"msg":"incoming request"}
# {"level":30,"time":...,"service":"members-service","reqId":"req-e","res":{"statusCode":200},"responseTime":1.47,"msg":"request completed"}
```

One JSON object per line. `level` is pino's number: 30 = info, 40 = warn, 50 = error.
`reqId` ties a request's lines together. `/health` probes are deliberately not logged.

To turn on debug logs: `helm upgrade ... --set config.logLevel=debug` (it's in the
ConfigMap), or edit `charts/members-service/values.yaml`.

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
