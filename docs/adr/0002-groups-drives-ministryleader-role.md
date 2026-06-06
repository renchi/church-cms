# ADR-0002 — Groups drives MinistryLeader role assignment in Identity

**Date:** June 2026  
**Status:** Accepted  
**Context:** Groups bounded context → Identity bounded context

---

## Context

When a church admin assigns a group leader, two things must happen:

1. The `Group` aggregate in the Groups context records the new `leaderId`
2. The `User` in the Identity context receives the `MinistryLeader` role

The question is which context initiates this flow and which reacts.

## Decision

**Groups drives the flow.** The Groups context publishes `GroupLeaderAssigned`. The Identity context listens to this event and reactively assigns the `MinistryLeader` role to the corresponding user.

Groups does not call Identity directly — the coupling is event-based and one-directional.

## Rationale

Leader assignment is a **business act** that originates in the context of a specific group. A church admin thinks: "I am assigning Maria as the leader of the Young Adults group." The resulting login permission is an infrastructural side effect of that decision, not the cause of it.

The alternative — Identity driving the flow — would mean a church admin grants a role in a settings screen, which then triggers group assignment. This inverts the natural direction of the business action and couples a generic subdomain (Identity) to a supporting subdomain (Groups) in the wrong direction.

### Alternatives considered

| Option | Problem |
|---|---|
| Identity drives (admin assigns role first, Groups reacts) | Inverts the natural business flow; couples Identity to Groups |
| Independent actions (admin does both manually) | Operational burden; risk of state diverging between contexts |
| Groups calls Identity synchronously | Creates runtime coupling; Groups fails if Identity is unavailable |

## Consequences

- Identity must subscribe to `GroupLeaderAssigned` events from the Groups context
- Role revocation also flows from Groups: a new `GroupLeaderAssigned` (replacing the old leader) or `MemberLeftGroup` for the outgoing leader triggers Identity to remove the `MinistryLeader` role
- If a `MinistryLeader` role needs to be granted *without* a group assignment (e.g. a pastoral assistant), that is an exceptional case handled directly in Identity by an admin — it falls outside this flow
- If Groups introduces multiple simultaneous leaders per group in the future, the role revocation logic in Identity must be updated to check whether the member still leads *any* group before removing the role
