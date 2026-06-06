# ADR-0008 — Database Hosting Strategy

**Date:** June 2026
**Status:** Accepted
**Linear:** CMS-8, CMS-14 (related)
**Context:** Where each service's database runs, in development and production

---

## Context

The system uses a **database-per-service** model (see [context map](context-map.md)):
each bounded context owns its data exclusively and no context reads another's
database directly. So Members and Events each get their **own** PostgreSQL database —
never a shared one.

The question is *where* those databases run. This decision is shaped by two competing
pulls:

- This is a **learning project** ([ADR-0007](0007-learning-scope-and-roadmap.md)) — running
  the database ourselves teaches Docker and Kubernetes stateful concepts.
- The data is **sensitive**: member PII (contact details) and financial records
  (giving history). In production that demands encryption, automated backups, and
  point-in-time recovery.

---

## Decision

Use a **stage-dependent** approach.

### Development → Postgres in Docker (local)
Run each service's Postgres as a container via docker-compose (CMS-8). Disposable,
fast to reset, zero cost.

### Learning / cluster stage → Postgres in minikube
Deploy Postgres into the Kubernetes cluster (CMS-14) using a StatefulSet (or Helm
chart) backed by a PersistentVolume, with credentials in a Secret. **The point is the
learning** — this is how we internalise stateful workloads, PersistentVolumes, and
Secrets, which are among the highest-value K8s concepts.

### Production (if/when deployed for real) → managed cloud database
Use a managed Postgres provider (Neon, Supabase, AWS RDS, or Google Cloud SQL). The
provider handles backups, failover, patching, and encryption-at-rest. The application
runs in Kubernetes and connects to the **external** managed database via a Secret.

---

## Rationale

- **Managed cloud is the modern production default.** You rarely run your own database
  server in production anymore — a managed service gives backups, HA, and patching for
  free, and you only get a connection string to manage.
- **Sensitive data raises the stakes.** Church PII + giving records make automated
  backups, point-in-time recovery, and encryption non-negotiable for production. A
  database on a local machine is a real data-loss and privacy risk.
- **Databases as "pets", clusters as "cattle".** Running a *production* database
  *inside* Kubernetes is generally discouraged: the cluster is disposable, the data is
  precious. The standard pattern is stateless apps in K8s pointing at a managed
  database outside the cluster.
- **But for learning, run it in-cluster anyway.** The pain of running a stateful
  workload in K8s is exactly the lesson — and it is why the managed-DB pattern exists.

---

## Consequences

**Positive**
- Learns Docker (dev) and K8s stateful concepts (minikube) without cost.
- Production path is the industry-standard, low-maintenance, secure default.
- Database-per-service is preserved at every stage (two separate DBs, not one shared).

**Negative / trade-offs**
- Three environments to keep config-compatible. Mitigated by Prisma abstracting the
  connection and by injecting the connection string via env var / Secret everywhere.
- The in-cluster minikube database is **not** a production-grade setup (no real HA or
  backup strategy) — and that is intentional; it is a learning artifact, not a target
  for real data.

---

## Decision Log

| Decision | Rationale |
|---|---|
| Local Docker Postgres for development | Disposable, fast, free |
| In-cluster Postgres on minikube | Teaches stateful workloads / PersistentVolumes / Secrets |
| Managed cloud Postgres for real production | Modern default; backups + encryption + HA handled by provider |
| Never run the production database inside K8s | Cluster is disposable, data is precious |
| One database per service at every stage | Enforces the database-per-service boundary from the context map |
