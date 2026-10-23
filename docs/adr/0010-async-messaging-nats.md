# ADR-0010 — Async messaging: NATS JetStream, transactional outbox, idempotent consumers

**Date:** October 2026
**Status:** Accepted
**Linear:** CMS-22
**Context:** How the Members and Events contexts tell each other about things that happened

---

## Context

ADR-0007 makes stage 9 "wire NATS between Members ↔ Events". The context map and
ADR-0004 already name the two events that cross the boundary:

- **`MemberArchived` (Members → Events).** Events declines the member's volunteer
  assignments on future, still-scheduled events.
- **`AttendanceRecorded` (Events → Members).** Members keeps a denormalised
  attendance summary: a total count and the last date seen.

Both aggregates already _return_ these events (`Member.archive()`,
`Attendance.record()`). Nothing publishes them yet.

The original CMS-22 ticket wired subscribers into Communications and Groups. Both
services are deferred (ADR-0007), so the ticket was re-scoped to the two live
services.

Moving an event from one service to another raises three questions:

1. **Which broker?**
2. **How does the publisher avoid losing an event?** Saving to Postgres and
   publishing to the broker are two separate writes. A crash between them leaves
   one done and the other not. This is the _dual-write problem_.
3. **What happens when a message arrives twice?** Brokers that persist messages
   deliver them _at least once_. A consumer that crashes before acknowledging a
   message gets it again.

---

## Decision

### 1. NATS with JetStream

- **NATS** is a single small server, installed with the official `nats` Helm
  chart, so it fits next to Prometheus and Grafana in a 6 GB minikube.
- **JetStream** is the persistence layer. Messages are stored in a **stream** on
  disk, and each subscriber is a **durable consumer** that remembers how far it
  has read. A consumer that was down catches up when it comes back.
- Kafka would teach the same ideas with much more to run. RabbitMQ is a fine
  alternative, but NATS was already in the context map.

### 2. Each publisher owns its stream

| Stream    | Subjects        | Created by      | Durable consumer on it         |
| --------- | --------------- | --------------- | ------------------------------ |
| `MEMBERS` | `cms.members.>` | members-service | `events-service` (archived only) |
| `EVENTS`  | `cms.events.>`  | events-service  | `members-service` (attendance) |

- Subjects: `cms.members.archived`, `cms.members.registered` (CMS-27) and
  `cms.events.attendance.recorded`.
- Each durable consumer sets a **filter subject**, so a new subject on a stream
  reaches nobody until a consumer asks for it. `events-service` filters on
  `cms.members.archived`, which is why publishing `MemberRegistered` didn't
  change it.
- `MemberRegistered` is published before its consumer exists. A new durable
  consumer starts from the oldest message still stored, so the first consumer
  (CMS-20) sees at most the stream's 7 days of backlog. It must pick its
  deliver policy on purpose (all, new, or by start time).
- The stream configurations live in the shared contract (`STREAMS` in
  `@cms/events`). At startup each service declares **both** streams ("add, or
  update if it exists") and then its own durable consumer on the other's stream.
  Because the configuration is shared, whichever service starts first creates the
  streams, and neither has to start before the other. No central setup script owns
  the topology.
- Each publisher still _owns_ its stream in the sense that matters: only
  members-service publishes to `cms.members.>`, and only it decides what goes there.

### 3. The wire contract lives in `@cms/events`

- `packages/events` holds the **wire** types (`MemberArchivedV1`,
  `MemberRegisteredV1`, `AttendanceRecordedV1`), the subject names, and `parse*` guards that check
  incoming JSON.
- It is the **only** package both contexts may import. Each service's domain keeps
  its own internal event types. A mapper in `infrastructure/` translates
  domain event → wire event, so the domain never depends on the wire format.
- Every message has the same **envelope**: `{ id, type, version, occurredAt, data }`.
  The `id` is unique per message and is what deduplication uses. `version` lets
  the schema evolve later. The event's own facts live in `data`, so a field like
  `data.eventId` (the church event) never gets confused with the message id.

### 4. Transactional outbox

- The repository writes the aggregate **and** an `OutboxMessage` row in **one**
  database transaction. Either both are saved or neither is.
- A **relay** loop in the same service polls unpublished outbox rows about once a
  second, publishes each to JetStream, and then marks it `publishedAt`.
- The relay sends the outbox row id as the `Nats-Msg-Id` header. If the relay
  crashes after publishing but before marking the row, it publishes again, and
  JetStream drops the duplicate (within its 2-minute dedupe window).
- **One relay at a time per service.** Every Pod runs a relay (the charts run 2+), so
  each batch runs inside a transaction that first takes a Postgres **advisory lock**
  (`pg_try_advisory_xact_lock`). The Pod that gets it publishes the batch; the others
  skip that tick. So each row is published once, in `createdAt` order. The lock is
  released when the transaction ends, including when the Pod dies. The handlers are
  still written to be order-independent (a count plus "latest date wins"; declining is
  the same in any order), because redelivery after a `nak` can reorder messages anyway.
- Only **cross-context** events go through the outbox. Internal events such as
  `VolunteerDeclined` stay as return values.

### 5. Idempotent consumers

- Each consumer records the message `id` in a `ProcessedMessage` table, **in the same
  transaction** as the change the message causes. If the `id` is already there,
  the message is acknowledged and skipped.
- The application layer gets this through a `UnitOfWork` port:
  `runOnce(messageId, work)`. The Prisma implementation opens a transaction, runs
  `INSERT … ON CONFLICT DO NOTHING` for the id, and runs `work` with repositories
  bound to that transaction only if the insert added a row. If two deliveries of
  the same message race, Postgres's row lock makes the second wait and then insert
  nothing.
- **Concurrent writers to one aggregate.** The consumer now writes to `Member` in the
  background, alongside HTTP requests and the other Pod's consumer. `Member` therefore
  has a `version` column (optimistic locking, like `ServiceEvent`): a save based on a
  stale copy throws `ConflictError` instead of overwriting the newer change. HTTP gets
  `409`; the consumer's transaction rolls back (processed id included) and the message
  is `nak`ed, so the retry works on fresh data.
- Acknowledgement rules:
  - `ack`: processed, or already processed.
  - `term`: the message can never be processed (bad JSON, unknown version). Retrying won't help.
  - `nak`: a transient failure, such as the database being down or a version conflict.
    JetStream redelivers it later, with a growing delay (1 s … 30 s), **with no limit**
    (`max_deliver: -1`). A limit would silently drop valid messages after a long enough
    outage; messages that can never succeed are `term`ed instead.
- If the consumer loop dies on its own (its durable consumer was deleted, say), the
  service exits, so Kubernetes restarts the Pod and startup recreates the consumer.
  Otherwise the Pod would stay Ready while processing nothing.

---

## Consequences

**Good**

- No lost events: if the aggregate was saved, the event is saved with it, and it
  will be published once NATS is reachable.
- A consumer that is down, or slow, doesn't break the publisher. Archiving a
  member works even while events-service is restarting.
- Redelivery is harmless, so we can lean on JetStream's retries.

**Costs**

- **Eventual consistency.** A member's attendance count updates a moment _after_
  the check-in, not in the same request.
- Two extra tables and a relay loop per service.
- A polling relay adds up to about a second of latency and does a small query
  every second, even when there is nothing to send.
- Debugging now crosses a bus. Without tracing, follow a message by its `id`
  in both services' logs.

## Evolution path

| Now                                           | Trigger                                    | Then                                                                                  |
| --------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------- |
| One relay batch at a time per service (advisory lock) | One relay can't keep up with the outbox | Let relays share the work: `SELECT … FOR UPDATE SKIP LOCKED` hands each relay different rows (ordering is then per relay, not global) |
| Relay polls the outbox table                  | Latency or DB load from polling matters    | Postgres `LISTEN/NOTIFY` to wake the relay, or change-data-capture (Debezium)         |
| `version: 1` on every wire event              | A breaking change to an event's payload    | Publish `V2` alongside `V1` until every consumer has moved, then retire `V1`          |
| `ProcessedMessage` and published `OutboxMessage` rows kept forever | The tables grow large | A cleanup job: delete processed ids older than the stream's 7-day retention (they can't be redelivered any more) and published outbox rows after a few days |
| Follow messages by `id` in logs               | Cross-service debugging gets painful       | OTel trace context in message headers, plus the Collector and Tempo (ADR-0009)        |
| One NATS server, file storage on one PVC      | Production                                 | A 3-node NATS cluster with replicated streams (`replicas: 3`)                         |
| Comms and Groups subscribers absent (deferred) | Those services are un-deferred            | They add their own durable consumers on `MEMBERS`. Members doesn't change. `MemberRegistered` is already published for this (CMS-27) |
| `MemberRegistered` is thin: `data: { memberId }` (CMS-27) | A consumer's lookup of name/email back to Members proves too slow or too fragile | Add the fields to V1. That's additive, so no consumer breaks. Removing a field would need a V2, which is why the event started thin and keeps person data out of the stream and the outbox |
