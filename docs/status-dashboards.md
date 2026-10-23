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
| Logs from every Pod (deleted ones too), Kubernetes events | <http://grafana.cms.local> → Explore → *Loki* → e.g. `{app="members-service"} \| json` ([LogQL cheat sheet](observability.md#9-logql-cheat-sheet-our-fields)) |
| Prometheus: scrape targets (is each Pod `up`?) | `kubectl -n monitoring port-forward svc/kube-prometheus-stack-prometheus 9090` → <http://localhost:9090/targets> |
| NATS: streams and consumers as JSON (messages stored, pending per consumer) | `kubectl -n nats port-forward pod/nats-0 8222` → <http://localhost:8222/jsz?consumers=true> ([runbook](messaging.md)) |

If `cms.local` doesn't resolve, the `/etc/hosts` entry is missing. See step 3 of
[k8s-local-dev.md](k8s-local-dev.md).

### The same from a terminal

```bash
kubectl get pods -w                    # watch pods roll over live (Ctrl+C to stop)
kubectl get deploy -o jsonpath='{range .items[*]}{.metadata.name}{"  "}{.spec.template.spec.containers[0].image}{"\n"}{end}'
                                       # which commit each service is running
kubectl logs <members-pod> -c migrate  # migration output (same for <events-pod>)
helm history members-service           # every deploy, including rollbacks (or events-service)

# Messaging (docs/messaging.md): is anything stuck between the services?
kubectl exec -n nats deploy/nats-box -- nats stream ls          # messages stored per stream
kubectl exec -n nats deploy/nats-box -- nats consumer ls MEMBERS # "Unprocessed" > 0 for long = a stuck consumer
kubectl exec deploy/members-postgres -- psql -U cms_user -d members_db -tAc \
  'SELECT count(*) FROM "OutboxMessage" WHERE "publishedAt" IS NULL'   # > 0 for long = the relay can't publish
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

---

## Watching the agent

Long workflow steps (the cluster build in `/verify`, the CI and Deploy watches in `/ship`)
run in the background, so the chat stays free and you can ask questions while they run.
Their progress lives in a status record per ticket, `.claude/state/<ticket>.json`, written
only by [`scripts/agent-status.sh`](../scripts/agent-status.sh). The concepts behind it are
in [study-guide §12.4](study-guide.md#124-working-asynchronously-with-an-agent-cms-34).

Three ways to read it, from least to most effort:

1. **The status line** at the bottom of the Claude Code terminal (run `claude` in a
   terminal). It updates after every message:
   ```
   CMS-34 · start ✓ · plan ✓ · implement ✓ · verify ✓ · review ✓ · ci …
   ```
   `✓` done, `…` running, `⏸ waiting for you`, `✗` failed, `? stale`. The status line
   is a terminal feature: the VS Code chat panel doesn't show it, so use 2 or 3 there.
2. **Ask in the chat**, in your own words: "is the review done?", "is CI green?", "what
   agents are working?". That runs `/status`: the record, plus background tasks and agents,
   plus a live `gh` check for anything still running. Typing `/status` does the same.
3. **The record itself**, from any terminal in the repo:
   ```bash
   scripts/agent-status.sh show
   # CMS-34  branch cms-34/agent-async-status  PR #24  (updated 2026-10-22T09:41:02Z)
   #   start      done     2026-10-22T09:02:11Z  branch cms-34/agent-async-status
   #   verify     done     2026-10-22T09:30:40Z  4 steps pass, 1 skipped
   #   ci         running  2026-10-22T09:40:58Z  gh pr checks --watch
   ```
   On `main` (just after a merge) it shows the newest record. Add `--ticket CMS-<n>` for
   another one.

**What `stale` means.** The record says `running`, but the process that would update it is
gone (`kill -0 <pid>` fails). Usually the Claude Code session that started the step was
closed: background tasks belong to their session. The step itself may well have finished
on GitHub. Check it live (`gh pr checks <pr>`, or `scripts/watch-deploy.sh <sha>`), or just
ask, since `/status` does that check for you.

**What `waiting` means.** The agent needs you. Today that's only the merge: `/ship` stops
at `merge ⏸ waiting for you` and asks "Merge PR #n?". It never merges on its own.

### Exercises

Use a throwaway folder so the real records stay clean:

```bash
export AGENT_STATUS_DIR=/tmp/agent-status-demo     # every command below uses it
```

1. **Watch a step run.** Start one, then read it while it runs:
   ```bash
   scripts/agent-status.sh --ticket DEMO-1 run verify -- sleep 30 &
   scripts/agent-status.sh --ticket DEMO-1 show
   #   verify     running  …  sleep 30
   ```
   After 30 s, `show` again. Expected: `verify done`. The wrapper wrote that, not you.
2. **A failure is recorded by exit code.**
   ```bash
   scripts/agent-status.sh --ticket DEMO-1 run ci -- false; echo "exit $?"
   # exit 1
   scripts/agent-status.sh --ticket DEMO-1 show | grep ci
   #   ci         failed   …  exit 1: false
   ```
3. **A caught signal vs one that can't be caught.**
   ```bash
   scripts/agent-status.sh --ticket DEMO-1 run deploy -- sleep 300 & pid=$!; sleep 1
   kill $pid                                      # SIGTERM: the wrapper traps it
   scripts/agent-status.sh --ticket DEMO-1 show | grep deploy
   #   deploy     failed   …  interrupted: sleep 300
   scripts/agent-status.sh --ticket DEMO-1 run deploy -- sleep 300 & pid=$!; sleep 1
   kill -9 $pid                                   # SIGKILL: no trap can run
   scripts/agent-status.sh --ticket DEMO-1 show | grep deploy
   #   deploy     stale    …  process 12345 is gone (session ended?) — re-check: sleep 300
   pkill -fx 'sleep 300'                          # the orphaned sleep: nobody was left to stop it
   ```
   `$!` is the PID of the last background command. Don't use `%1`: job numbers depend on
   what else the shell has running. Why the two kills differ: §12.4. Notice the leftover
   `sleep` after `kill -9`: the wrapper died before it could stop its child, which is what
   happens to a background task's command when its session dies.
4. **The status line by hand.** It's a script that reads JSON on stdin:
   ```bash
   unset AGENT_STATUS_DIR                         # back to the real records
   echo "{\"workspace\":{\"current_dir\":\"$PWD\"}}" | .claude/statusline.sh
   # CMS-34 · start ✓ · plan ✓ · …                 ← your current branch's record
   ```
5. **The real thing.** During your next `/ship`, while CI runs, ask "is CI done?". Expected:
   an answer in a few lines naming which checks are still running.

## Quick "is something down?" checklist

| Symptom | Look at |
| --- | --- |
| Deploy stuck in **Queued** | Runners page (Offline?) → `svc.sh status`; also `minikube status` |
| CI jobs **cancelled**, "not acquired by Runner" | <https://www.githubstatus.com>. It's a GitHub outage; re-run later |
| `cms.local` doesn't load | Is `minikube tunnel` running? Is minikube up? |
| Pods not Ready | Kubernetes Dashboard → the pod → Events and Logs |
| API slow or erroring | Grafana RED dashboard → which route, since when → the dashboard's *Logs — warnings and errors* panel, or Explore → Loki for those requests |
| A change in one service never shows up in the other (archive → volunteers still pending; check-in → count unchanged) | The two terminal checks under "Messaging" above: unpublished outbox rows point at the publisher (or NATS), unprocessed consumer messages at the consumer. See [messaging troubleshooting](messaging.md#troubleshooting) |
| The status line or `/status` says a step is **stale** | The session that ran it ended. Check it live: `gh pr checks <pr>` or `gh run list --workflow=Deploy` ("Watching the agent" above) |
| Grafana panels say **No data** | Prometheus Targets: is `members-service` (or `events-service`) up? See [observability troubleshooting](observability.md#troubleshooting) |

More symptoms and fixes: the debugging table in [ci-cd.md](ci-cd.md#debugging).
