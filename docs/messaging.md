# Messaging Runbook — NATS JetStream between the services

How the two services tell each other what happened, how to install the message bus
on minikube, and how to watch a message travel from one database to the other.
**Concepts first?** Read [study-guide §11](study-guide.md#11-async-messaging-with-nats-roadmap-stage-9).
**Why this design?** See [ADR-0010](adr/0010-async-messaging-nats.md).

Two flows, one in each direction. A third event, `MemberRegistered` (CMS-27), is also
published to `MEMBERS` but has no consumer until Communications exists (CMS-20, exercise 6):

```
members-service                         NATS (namespace nats)                   events-service
┌──────────────────────────┐           ┌───────────────────────┐            ┌─────────────────────────────┐
│ DELETE /members/:id      │           │ stream MEMBERS        │  durable   │ consumer "events-service"   │
│  ├─ Member  ─┐ one       │  relay    │  cms.members.>        ├───────────►│  → decline future volunteer │
│  └─ Outbox ──┘ transaction├─────────►│                       │            │    assignments (runOnce)    │
│                          │           │ stream EVENTS         │            │                             │
│ consumer "members-service"│◄──────────┤  cms.events.>         │◄───────────┤ relay ◄─ Outbox ─┐ one       │
│  → attendanceCount += 1  │  durable  │                       │            │       Attendance ┘ transaction│
│    (runOnce)             │           └───────────────────────┘            │ POST /events/:id/attendance │
└──────────────────────────┘                                                └─────────────────────────────┘
```

Each arrow out of a service is the **outbox relay**: it publishes rows the use case
saved in its own database. Each arrow in is a **durable consumer**: it remembers what
it has acknowledged, so a service that was down catches up when it returns.

Prerequisites: the cluster from [`k8s-local-dev.md`](k8s-local-dev.md) is running, with
both services and both Postgres instances.

> **Shortcut:** [`scripts/cluster-up.sh`](../scripts/cluster-up.sh) runs step 1 for you and
> checks step 3 at the end ("NATS: events-service consumes from MEMBERS"). Read on to learn what it does.

---

## 1. Install NATS

```bash
helm repo add nats https://nats-io.github.io/k8s/helm/charts/
helm upgrade --install nats nats/nats --version 2.15.0 \
  -n nats --create-namespace -f k8s/nats-values.yaml --wait
kubectl get pods,pvc -n nats
# pod/nats-0                     2/2   Running   0   40s
# pod/nats-box-547cfc86c-5vdpd   1/1   Running   0   40s
# persistentvolumeclaim/nats-js-nats-0   Bound   ...   1Gi   RWO   standard
```

What the flags and values do:

- `-n nats --create-namespace`: an add-on in its own namespace, like Traefik and
  monitoring. The services reach it at `nats://nats.nats.svc.cluster.local:4222`
  (`<service>.<namespace>.svc.cluster.local`), which is `config.natsUrl` in both charts.
- [`k8s/nats-values.yaml`](../k8s/nats-values.yaml): JetStream **on** (without it, a
  message with no listener at that moment is simply lost), file storage on a 1 Gi
  PVC (so messages survive a NATS restart), one server, small memory limits.
- `nats-0` has **2/2** containers: the server and a config reloader. `nats-box` is a
  small Pod with the `nats` CLI already pointed at the server. Steps 3–4 use it.

> The first `kubectl describe pod nats-0` may show `FailedScheduling … unbound immediate
> PersistentVolumeClaims`. That lasts a few seconds, until minikube's storage provisioner
> creates the volume. It's not an error.

## 2. Deploy (or redeploy) the services

Nothing NATS-specific to do: both charts already pass `NATS_URL` through their ConfigMap.
Deploy them as in [`k8s-local-dev.md` §7](k8s-local-dev.md#7-deploy-members-service). Then
check that each one connected:

```bash
kubectl logs deploy/members-service-members-service | grep 'connected to NATS'
# {"level":30,...,"service":"members-service","natsUrl":"nats://nats.nats.svc.cluster.local:4222","msg":"connected to NATS"}
kubectl logs deploy/events-service-events-service | grep 'connected to NATS'
```

> **Upgrading a cluster that ran before CMS-22?** The ConfigMap gains `NATS_URL`, and the
> `checksum/config` annotation on the Pod template makes Kubernetes roll the Pods for you.
> Without that annotation, running Pods would keep their old environment.

## 3. Look at the streams and consumers

A service declares both streams on startup (the config lives in `@cms/events`, so
whichever service starts first creates them), then its own durable consumer on the
other service's stream.

```bash
kubectl exec -n nats deploy/nats-box -- nats stream ls
# │ Name    │ Description │ Created             │ Messages │ Size │ Last Message │
# │ EVENTS  │             │ 2026-10-15 20:10:13 │ 0        │ 0 B  │ never        │
# │ MEMBERS │             │ 2026-10-15 20:10:13 │ 0        │ 0 B  │ never        │

kubectl exec -n nats deploy/nats-box -- nats consumer ls MEMBERS
# │ Name           │ Description │ Created             │ Ack Pending │ Unprocessed │ Last Delivery │
# │ events-service │             │ 2026-10-15 20:10:42 │           0 │           0 │ 51.26s        │
```

- **Unprocessed**: messages in the stream this consumer hasn't received yet.
- **Ack Pending**: messages delivered but not yet acknowledged (being handled now, or
  waiting to be redelivered after a `nak`).

Both at 0 = the consumer is caught up. The same as JSON, for scripts:
`nats consumer info MEMBERS events-service --json | jq '{num_pending, num_ack_pending}'`.

Both services run **2 replicas**, and both replicas use the **same** durable consumer.
JetStream then hands each message to **one** of them, like a work queue. That's why
"two Pods" doesn't mean "handled twice".

## 4. Follow one message end to end

No `minikube tunnel`? Go through Traefik with a port-forward instead, and send the Host
header yourself (the Ingress routes on it):

```bash
kubectl -n traefik port-forward svc/traefik 18080:80 &
H='Host: cms.local'; B=http://localhost:18080/api      # with the tunnel: B=http://cms.local/api, no -H
ADMIN=33333333-3333-4333-8333-333333333333
```

Create a member, a future event, and give the member a volunteer slot on it:

```bash
M=$(curl -s -H "$H" -H 'content-type: application/json' \
  -d '{"name":"Archie Volunteer","email":"archie@example.com"}' $B/members/members | jq -r .id)
E=$(curl -s -H "$H" -H 'content-type: application/json' \
  -d "{\"title\":\"Youth Night\",\"eventType\":\"event\",\"venue\":{\"name\":\"Hall\"},
       \"scheduledAt\":\"$(date -u -d '+2 days' +%FT%T.000Z)\",\"durationMinutes\":120,\"createdById\":\"$ADMIN\"}" \
  $B/events/events | jq -r .id)
curl -s -H "$H" -H 'content-type: application/json' \
  -d "{\"memberId\":\"$M\",\"role\":\"usher\",\"assignedById\":\"$ADMIN\"}" $B/events/events/$E/volunteers
# {"id":"33413806-..."}
```

Now archive the member, and follow the message through each hop:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X DELETE -H "$H" $B/members/members/$M
# 204

# Hop 1 — the outbox row, written in the same transaction as the archive:
kubectl exec deploy/members-postgres -- psql -U cms_user -d members_db -tAc \
  "SELECT id, subject, \"publishedAt\" FROM \"OutboxMessage\" WHERE payload->'data'->>'memberId'='$M'"
# 0b6e…|cms.members.archived|2026-10-15 20:11:48.9   ← publishedAt set: the relay has sent it

# Hop 2 — the message in the stream:
kubectl exec -n nats deploy/nats-box -- nats stream get MEMBERS --last-for cms.members.archived --json \
  | jq -r .data | base64 -d | jq .
# { "id": "0b6e…", "type": "MemberArchived", "version": 1, "occurredAt": "…", "data": { "memberId": "…" } }

# Hop 3 — events-service handled it:
kubectl logs -l app.kubernetes.io/name=events-service -c events-service --tail=200 \
  | grep 'member archived handled' | jq -c '{messageId, memberId, outcome, declined}'
# {"messageId":"0b6e…","memberId":"…","outcome":"applied","declined":1}

# Hop 4 — the effect, in the OTHER service's database:
kubectl exec deploy/events-postgres -- psql -U cms_user -d events_db -tAc \
  "SELECT role, status FROM \"VolunteerAssignment\" WHERE \"memberId\"='$M'"
# usher|declined
```

The **message id** (`0b6e…`) is the same in every hop: outbox row, `Nats-Msg-Id`,
the envelope's `id`, the consumer's log line and its `ProcessedMessage` row. Until we
have tracing (ADR-0009), it's how you follow one event across services.

The other direction works the same way. Check a second member in to an event that starts
within two hours (check-in opens two hours before the start), then read their summary:

```bash
M2=$(curl -s -H "$H" -H 'content-type: application/json' \
  -d '{"name":"Attie Attender","email":"attie@example.com"}' $B/members/members | jq -r .id)
E_SOON=$(curl -s -H "$H" -H 'content-type: application/json' \
  -d "{\"title\":\"Sunday Service\",\"eventType\":\"service\",\"venue\":{\"name\":\"Main Sanctuary\"},
       \"scheduledAt\":\"$(date -u -d '+1 hour' +%FT%T.000Z)\",\"durationMinutes\":90,\"createdById\":\"$ADMIN\"}" \
  $B/events/events | jq -r .id)
curl -s -H "$H" -H 'content-type: application/json' \
  -d "{\"memberId\":\"$M2\",\"method\":\"self\"}" $B/events/events/$E_SOON/attendance
curl -s -H "$H" $B/members/members/$M2 | jq '{name, attendanceCount, lastAttendedAt}'
# { "name": "Attie Attender", "attendanceCount": 1, "lastAttendedAt": "2026-10-15T20:11:49.014Z" }
```

---

## Troubleshooting

| Symptom | Cause → fix |
| --- | --- |
| A change never reaches the other service | Find the hop where it stops (step 4). Outbox row with `publishedAt` NULL → the **publisher** can't reach NATS: check its logs for `outbox publish failed`. Message in the stream but the consumer's **Unprocessed** isn't 0 → the **consumer** isn't running: check its logs for `connected to NATS` |
| `outbox publish failed; will retry` with `err: timeout`, every second | NATS is down or unreachable. Expected while it's away: the rows wait and drain once it's back (exercise 3). If NATS is up, check `NATS_URL` in the ConfigMap: `kubectl get cm members-service-members-service-config -o yaml` |
| Logs say `NATS_URL not set: messaging disabled` | The ConfigMap has no `NATS_URL` (the chart was rendered with `config.natsUrl=""`), or the Pod predates it. Redeploy the chart; the checksum annotation rolls the Pods |
| `nats consumer ls` shows **Ack Pending** that stays above 0 | A handler keeps failing, so the message is `nak`ed and redelivered with a growing delay (1 s … 30 s). The consumer's logs say `message failed; will retry` and why (often the database). It's retried until it succeeds (no `max_deliver` limit), so fix the cause and the backlog drains by itself. Messages behind it on the same consumer keep flowing; only the failing one waits |
| Logs say `invalid message; terminating` | A message that doesn't match the contract in `@cms/events` (bad JSON, wrong `type`, unknown `version`). It's `term`ed, not retried, because retrying can't fix it. It stays in the stream: `nats stream get` it by sequence number (in the log line, `seq`) to see what was sent |
| `attendance not applied` with `outcome: member-not-found` | Events recorded a check-in for a `memberId` that Members doesn't have. Events doesn't validate ids (a known gap). The message is acked; it can never succeed |
| `nats-0` Pending with `unbound immediate PersistentVolumeClaims` | The volume is still being created. Wait a few seconds. If it lasts: `kubectl get pvc -n nats` and `minikube addons list | grep storage-provisioner` |
| `nats stream ls` says `No Streams defined` (and `nats stream info MEMBERS` complains it `could not pick a Stream`) | No service has connected yet: the streams are created by the services, not by the Helm chart. Check step 2 |

---

## Hands-on exercises

Use the setup from step 4 (`$H`, `$B`, `$ADMIN`, the Traefik port-forward). Each exercise
breaks something on purpose and checks how the system reacts.

**1. Replay: the consumer is down while the event happens.** Give a new member a
volunteer slot (step 4), then:

```bash
kubectl scale deploy/events-service-events-service --replicas=0
curl -s -o /dev/null -w '%{http_code}\n' -X DELETE -H "$H" $B/members/members/$M
kubectl exec -n nats deploy/nats-box -- nats consumer info MEMBERS events-service --json | jq '{num_pending}'
kubectl exec deploy/events-postgres -- psql -U cms_user -d events_db -tAc \
  "SELECT status FROM \"VolunteerAssignment\" WHERE \"memberId\"='$M'"
kubectl scale deploy/events-service-events-service --replicas=2
kubectl rollout status deploy/events-service-events-service
# ...then run the psql query again
```

*Expected:* the archive still returns `204`: Members doesn't depend on Events being up.
`num_pending` is `1` and the assignment stays `pending` while events-service has no
Pods. A few seconds after it's back, `num_pending` is `0` and the assignment is
`declined`. The durable consumer remembered where it stopped. With core NATS (no
JetStream), that message would have been lost. Which line in
[`k8s/nats-values.yaml`](../k8s/nats-values.yaml) makes the difference?

**2. Idempotency: the same message twice.** Republish the last attendance message by
hand, with a new `Nats-Msg-Id` so JetStream accepts it as new:

```bash
MSG=$(kubectl exec -n nats deploy/nats-box -- nats stream get EVENTS \
  --last-for cms.events.attendance.recorded --json | jq -r .data | base64 -d)
kubectl exec -n nats deploy/nats-box -- nats pub cms.events.attendance.recorded "$MSG" -H Nats-Msg-Id:by-hand-1
kubectl logs -l app.kubernetes.io/name=members-service -c members-service --tail=100 \
  | grep 'attendance not applied' | jq -c '{messageId, outcome}'
```

*Expected:* the stream's message count goes up by one, but the member's
`attendanceCount` doesn't change. The log says `"outcome":"duplicate"`: the envelope's
`id` was already in `ProcessedMessage`. Now publish it again with the **same**
`Nats-Msg-Id:by-hand-1`. *Expected:* this time the stream's count doesn't even change.
JetStream itself dropped it (the stream's 2-minute `duplicate_window`). That's the
first of the two dedupe layers; the `ProcessedMessage` table is the second.

**3. The outbox: NATS is down while the event happens.**

```bash
kubectl scale statefulset/nats -n nats --replicas=0
curl -s -o /dev/null -w '%{http_code}\n' -X DELETE -H "$H" $B/members/members/$M
kubectl exec deploy/members-postgres -- psql -U cms_user -d members_db -tAc \
  "SELECT subject, \"publishedAt\" IS NULL AS waiting FROM \"OutboxMessage\" WHERE payload->'data'->>'memberId'='$M'"
kubectl logs deploy/members-service-members-service --since=30s | grep -c 'outbox publish failed'
kubectl scale statefulset/nats -n nats --replicas=1
kubectl rollout status statefulset/nats -n nats
# ...wait ~10 s, then run the psql query again
```

*Expected:* `204` even with NATS gone. The row shows `cms.members.archived|t` (waiting),
and the relay logs `outbox publish failed; will retry` about once a second. After NATS
returns: `cms.members.archived|f`. The relay published it on its own, and events-service
declined the slot. Also check `nats stream ls`: the messages from before the outage are
still there, because the stream is file-backed on a PVC. Think about what "publish right
after save" would have done here: the save succeeds, the publish throws, and the event is gone.

**4. Watch the consumer catch up.** Scale events-service to 0, archive **five** members
that have volunteer slots, and watch `nats consumer ls MEMBERS` as you scale it back up.

*Expected:* **Unprocessed** reads 5 while the service is down, then drops to 0 within a
few seconds of the Pods becoming Ready, as `Last Delivery` resets. The two replicas split
the five messages between them: count the `member archived handled` lines in each Pod's
logs (`kubectl logs <pod> -c events-service | grep -c 'member archived handled'`).

**5. A poison message.** Publish something that breaks the contract:

```bash
kubectl exec -n nats deploy/nats-box -- nats pub cms.members.archived '{"hello":"world"}'
kubectl logs -l app.kubernetes.io/name=events-service -c events-service --tail=50 | grep 'invalid message'
```

*Expected:* one `invalid message; terminating` line with `message.id must be a non-empty
string`, and **no** retries. Compare with a `nak`: why would retrying this message
forever be worse than dropping it?

**6. A message nobody reads yet: `MemberRegistered` (CMS-27).** Since CMS-27, registering
a member publishes a thin `MemberRegistered` to `cms.members.registered`. Its consumer,
Communications, doesn't exist until CMS-20. Register someone (from the form at
`http://cms.local/members/new` or with curl), then follow the message and see where it
stops:

```bash
M=$(curl -s -H "$H" -H 'content-type: application/json' \
  -d '{"name":"Reggie Newcomer","email":"reggie@example.com"}' $B/members/members | jq -r .id)

# Hop 1: the outbox row, written in the same transaction as the member:
kubectl exec deploy/members-postgres -- psql -U cms_user -d members_db -tAc \
  "SELECT id, subject, \"publishedAt\", payload->'data' FROM \"OutboxMessage\" WHERE payload->'data'->>'memberId'='$M'"
# 337b561b-…|cms.members.registered|2026-10-23 18:45:15.033|{"memberId": "e4ee20a6-…"}

# Hop 2: the message in the stream. Note what's NOT in it: no name, no email.
kubectl exec -n nats deploy/nats-box -- nats stream get MEMBERS --last-for cms.members.registered --json \
  | jq -r .data | base64 -d | jq .
# { "id": "337b561b-…", "data": { "memberId": "e4ee20a6-…" },
#   "type": "MemberRegistered", "version": 1, "occurredAt": "2026-10-23T18:45:14.280Z" }

# Where it stops: the stream has it, but the only consumer on MEMBERS doesn't want it.
kubectl exec -n nats deploy/nats-box -- nats stream subjects MEMBERS
# │ cms.members.archived │ 1     │ cms.members.registered │ 2     │
kubectl exec -n nats deploy/nats-box -- nats consumer info MEMBERS events-service --json \
  | jq '{filter_subject: .config.filter_subject, num_pending}'
# { "filter_subject": "cms.members.archived", "num_pending": 0 }
```

*Expected:* the outbox row has `publishedAt` set within about a second (the relay logs
`"published":1,"msg":"outbox events published"`), and its `data` is only `{ memberId }`.
The stream counts the new subject, but events-service's `num_pending` stays `0`: its
**filter subject** means it never sees registrations, which is why publishing a new event
needed no change in events-service. The messages simply wait in the stream for its 7-day
retention. When CMS-20 adds a durable consumer filtered to `cms.members.registered`, it
starts from what's still in the stream.

Two things to think about (study-guide §11.5):

- The key order in hop 2 differs from the code that built the message (`data` comes before
  `type`). The outbox stores the payload as Postgres `jsonb`, which doesn't keep key order.
  That's harmless: a JSON object has no order, and the parsers look fields up by name.
- The welcome email will need Reggie's email address, and it isn't in the message. Where
  will CMS-20 get it, and what should its consumer do if Members is down at that moment?
