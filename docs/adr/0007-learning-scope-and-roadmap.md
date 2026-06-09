# ADR-0007 — Learning-Focused Scope & Roadmap

**Date:** June 2026
**Status:** Accepted
**Linear:** CMS-4 (follow-up)
**Context:** Whole project — scope and sequencing

---

## Context

This project's **primary purpose is learning**, not shipping a product quickly or
minimizing maintenance. The explicit learning goals are:

1. **Docker & containers** — images, multi-stage builds, compose
2. **Kubernetes** — minikube, manifests, Helm, Ingress, autoscaling, observability
3. **System design** — service boundaries, async events, eventual consistency
4. **Software architecture / Domain-Driven Design** — _an emphasized priority_
5. **Using AI tools** — issue-driven development with Claude Code + Linear

Given that goal, the microservices + K8s + NATS + DDD architecture defined in the
[context map](context-map.md) is **deliberate learning scope**, not over-engineering.
The risk is not "too much architecture" — it is **trying to learn all of it at once**
and building the same service six times (which teaches little after the second).

---

## Decision

### 1. Build a two-service vertical slice first

Implement **only two bounded contexts** end-to-end before touching the rest:

- **Members** (Core Domain) — the richest aggregate, our DDD anchor
- **Events** (Supporting) — chosen for the best cross-service event lesson

> **Why Events as the second service?** It has a **two-way** event relationship with
> Members: Events publishes `AttendanceRecorded` (Members consumes it to update a
> denormalised attendance summary) **and** consumes `MemberArchived` (to drop the
> member from future volunteer schedules). That round-trip is the clearest possible
> demonstration of async choreography over a message bus.

### 2. Defer the remaining contexts

**Finance, Communications, Groups, and Identity** are deferred until the
Members + Events slice runs fully on Kubernetes with events flowing through NATS.
They are not cancelled — they remain valuable, but building them now is mostly
**repetition** that does not advance the learning goals. They are tagged `deferred`
in Linear.

### 3. Add observability (new requirement)

The original plan had no observability, which leaves a hole in the Kubernetes and
system-design learning goals. Add **Prometheus + Grafana** on minikube plus
structured logging once the cluster is up. Operating a system you can _see_ is one
of the highest-value K8s skills.

---

## Learning Roadmap (sequence)

Each layer should feel solid before starting the next.

| #   | Stage                                                | Linear                 | Skill unlocked                      |
| --- | ---------------------------------------------------- | ---------------------- | ----------------------------------- |
| 1   | Build Members service (Fastify + Prisma, DDD layers) | CMS-5, CMS-6           | **DDD in code**, clean architecture |
| 2   | Tests for Members                                    | CMS-12                 | TDD, confidence to refactor         |
| 3   | Containerize: Dockerfile → docker-compose            | CMS-7, CMS-8           | **Docker mastery**                  |
| 4   | Frontend + compose it in                             | CMS-9, CMS-10, CMS-11  | full local stack                    |
| 5   | Kubernetes: minikube → manifests → Ingress → Helm    | CMS-13, CMS-14, CMS-15 | **Kubernetes**                      |
| 6   | CI/CD pipeline                                       | CMS-16                 | automation                          |
| 7   | **Observability** (Prometheus + Grafana)             | _new ticket_           | operating distributed systems       |
| 8   | Build Events service                                 | CMS-18                 | repeat DDD pattern in a 2nd context |
| 9   | Wire NATS between Members ↔ Events                   | CMS-22                 | **system design / async events**    |

After stage 9 the learner has touched every goal end-to-end. The deferred contexts
(Finance, Comms, Groups, Identity) can then be added one at a time as extra practice.

---

## Consequences

**Positive**

- Every learning goal is exercised with far less repetitive work.
- A complete, observable, event-driven slice on K8s is more impressive — and more
  instructive — than six half-built services.
- DDD is practiced twice (Members deeply, Events to confirm the pattern transfers),
  which is exactly how the pattern is internalised.

**Negative / trade-offs**

- The app is not feature-complete as a church CMS. Acceptable — that was never the goal.
- Cross-context patterns that only appear with 3+ services (e.g. a service consuming
  events from two upstreams) are deferred. Revisit when adding the next context.

---

## Decision Log

| Decision                                                     | Rationale                                                                       |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| Two-service slice (Members + Events) before the rest         | Maximise learning per unit of effort; avoid building the same service six times |
| Events chosen as 2nd service                                 | Bidirectional events with Members = best async-choreography lesson              |
| Finance / Comms / Groups / Identity deferred (not cancelled) | Repetition once the pattern is learned; tagged `deferred` in Linear             |
| Add observability (Prometheus + Grafana)                     | Closes a gap in the K8s + system-design learning goals                          |
