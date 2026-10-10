# Status Dashboards

Where to look to see what the pipeline and the cluster are doing. Bookmark the GitHub
links. The cluster links are local to the minikube machine and need a command running
first.

For *how* the pipeline works, see [ci-cd.md](ci-cd.md). For setting up the cluster, see
[k8s-local-dev.md](k8s-local-dev.md).

---

## Pipeline (GitHub)

These work from any browser.

| What | URL |
| --- | --- |
| All workflow runs | <https://github.com/renchi/church-cms/actions> |
| CI runs only | <https://github.com/renchi/church-cms/actions/workflows/ci.yml> |
| Deploy runs only | <https://github.com/renchi/church-cms/actions/workflows/deploy.yml> |
| Open pull requests and their checks | <https://github.com/renchi/church-cms/pulls> |
| Self-hosted runner (Idle / Active / Offline) | <https://github.com/renchi/church-cms/settings/actions/runners> |
| Branch protection rules | <https://github.com/renchi/church-cms/settings/branches> |
| Pushed container images and their SHA tags | <https://github.com/renchi?tab=packages> |
| GitHub's own health (outages) | <https://www.githubstatus.com> |

**Reading a run:** click a run to see its jobs, then a job to see live logs step by step.
A finished Deploy run shows a summary at the bottom with each service's image and how
long it took.

The same from a terminal (run inside `~/church-cms`, or add `-R renchi/church-cms`):

```bash
gh run list                      # recent runs and their status
gh run watch                     # follow a running run live
gh run view <id> --log-failed    # only the log lines from failed steps
gh pr checks <pr> --watch        # the checks on a pull request
```

---

## Kubernetes cluster (local)

These addresses only work on the machine running minikube, and only while minikube is up
(`minikube status`; `minikube start` if it isn't).

### Kubernetes Dashboard: pods, deployments, logs, events

```bash
minikube dashboard --url
```

This prints a URL like
`http://127.0.0.1:<port>/api/v1/namespaces/kubernetes-dashboard/services/http:kubernetes-dashboard:/proxy/`.
The port changes every time. Keep the terminal open while you use it. Without `--url`,
it opens the browser for you.

### The app and Traefik, through the Ingress

First start the tunnel in its own terminal and leave it running:

```bash
sudo -E minikube tunnel
```

| What | URL |
| --- | --- |
| Web frontend | <http://cms.local> |
| Members API health | <http://cms.local/api/members/health> (expect `{"status":"ok"}`) |
| Events API health | <http://cms.local/api/events/health> (expect `{"status":"ok"}`) |
| Upcoming events | <http://cms.local/api/events/events> |
| Traefik dashboard (routers, services, middlewares) | <http://traefik.cms.local/dashboard/> |
| Grafana: RED dashboard (rate, errors, latency per service) | <http://grafana.cms.local> → Dashboards → *CMS — Service RED metrics* ([setup](observability.md)) |
| Prometheus: scrape targets (is each Pod `up`?) | `kubectl -n monitoring port-forward svc/kube-prometheus-stack-prometheus 9090` → <http://localhost:9090/targets> |

If `cms.local` doesn't resolve, the `/etc/hosts` entry is missing. See step 3 of
[k8s-local-dev.md](k8s-local-dev.md).

### The same from a terminal

```bash
kubectl get pods -w                    # watch pods roll over live (Ctrl+C to stop)
kubectl get deploy -o jsonpath='{range .items[*]}{.metadata.name}{"  "}{.spec.template.spec.containers[0].image}{"\n"}{end}'
                                       # which commit each service is running
kubectl logs <members-pod> -c migrate  # migration output (same for <events-pod>)
helm history members-service           # every deploy, including rollbacks (or events-service)
```

---

## Self-hosted runner (on the minikube machine)

The Runners page above shows whether GitHub can see the runner. To check the machine
side:

```bash
sudo ~/actions-runner/svc.sh status    # is the service running?
journalctl -u 'actions.runner.*' -f    # live log, e.g. "Running job: deploy (web)"
```

---

## Watching a merge go live

Open two terminals side by side:

1. `gh run watch`: CI runs on `main`, then Deploy starts automatically.
2. `kubectl get pods -w`: the pods of each changed service (members-service, events-service, web) are replaced.

The first measured run took **2 min 37 s** from merge to both services live.

## Quick "is something down?" checklist

| Symptom | Look at |
| --- | --- |
| Deploy stuck in **Queued** | Runners page (Offline?) → `svc.sh status`; also `minikube status` |
| CI jobs **cancelled**, "not acquired by Runner" | <https://www.githubstatus.com>. It's a GitHub outage; re-run later |
| `cms.local` doesn't load | Is `minikube tunnel` running? Is minikube up? |
| Pods not Ready | Kubernetes Dashboard → the pod → Events and Logs |
| API slow or erroring | Grafana RED dashboard → which route, since when → then `kubectl logs` for those requests |
| Grafana panels say **No data** | Prometheus Targets: is `members-service` (or `events-service`) up? See [observability troubleshooting](observability.md#troubleshooting) |

More symptoms and fixes: the debugging table in [ci-cd.md](ci-cd.md#debugging).
