# ADR-0001 — GroupMembership is a separate aggregate root

**Date:** June 2026  
**Status:** Accepted  
**Context:** Groups bounded context

---

## Context

The Groups context tracks which members belong to which groups. The two natural modelling options are:

1. `GroupMembership` as an entity _inside_ the `Group` aggregate
2. `GroupMembership` as its own aggregate root

## Decision

`GroupMembership` is a **separate aggregate root**, not an entity inside `Group`.

## Rationale

There are no cross-membership invariants on `Group`:

- No capacity limits (any number of members may join)
- No minimum leader count enforced at enrolment time
- No uniqueness constraint enforced at the aggregate level

Without spanning invariants, there is no correctness reason to load all memberships when operating on a `Group`. A church group with 200 members would force loading 200 `GroupMembership` entities on every command that touches the group — an unbounded aggregate that grows with every enrolment.

Each `GroupMembership` enforces only its own state machine:

```
Pending → Approved → Exited
```

That state machine is self-contained and needs no data from the parent `Group` to enforce its transitions.

## Consequences

- `Group` and `GroupMembership` each have their own repository
- Commands that need both (e.g. "show group with member count") use a **read model** that joins across the two, not the domain aggregates
- If capacity limits are introduced in the future, this decision must be revisited — `GroupMembership` approval would then need to load `Group` to check current count, which may require merging them into one aggregate or introducing a saga
