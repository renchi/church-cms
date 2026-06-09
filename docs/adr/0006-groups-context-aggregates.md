# ADR-0006 — Groups Bounded Context: Aggregates & Domain Model

**Date:** June 2026  
**Status:** Accepted  
**Linear:** CMS-3  
**Context:** Groups bounded context

---

## Overview

The Groups context manages the sub-communities within the church — cell groups, choirs, ministry teams, and so on. It references members by ID only. Leader assignment in this context triggers role assignment in the Identity context reactively (see ADR-0002).

---

## Aggregate Roots

### `Group`

Represents a named sub-community within the church.

```typescript
class Group {
  id: string;
  name: string; // e.g. "Young Adults Cell Group A"
  groupType: GroupType; // value object
  leaderId: string; // reference to Member — the assigned leader
  description: string | null;
  meetingSchedule: string | null; // free text for MVP: "Every Thursday 7PM"
  isActive: boolean;
  createdById: string;
  createdAt: Date;
}
```

**Invariants:**

- `name` must be unique within the same `groupType`
- `leaderId` must reference an active Member
- An inactive `Group` does not appear in member-facing enrollment lists
- Deactivating a `Group` automatically triggers `MemberLeftGroup` for all current members

**Domain events published:**
| Event | Payload |
|---|---|
| `GroupCreated` | `{ groupId, name, groupType, leaderId }` |
| `GroupDeactivated` | `{ groupId }` |
| `GroupLeaderAssigned` | `{ groupId, newLeaderId, previousLeaderId }` |

> **Note:** Identity context listens to `GroupLeaderAssigned` and reactively assigns/revokes the `MinistryLeader` role. See ADR-0002 for full rationale.

---

### `GroupMembership`

Records a single member's enrollment in a specific group.

```typescript
class GroupMembership {
  id: string;
  groupId: string; // reference to Group
  memberId: string; // reference to Member
  status: MembershipStatus; // value object: pending | approved | exited
  role: MemberRole; // value object: member | assistant_leader
  requestedAt: Date;
  approvedAt: Date | null; // null when status is pending
  approvedById: string | null; // leader or admin who approved
  exitedAt: Date | null;
}
```

**Invariants:**

- A member can only have one active `GroupMembership` per group (pending or approved)
- A member may belong to multiple different groups simultaneously
- An `exited` membership is terminal — re-joining creates a new `GroupMembership` record
- Only a group leader or admin can approve or reject a pending membership

**State machine — `MembershipStatus`:**

```
pending ──► approved ──► exited
   │
   └──────────────────► rejected  (terminal — member must re-apply)
```

**Domain events published:**
| Event | Payload |
|---|---|
| `MemberJoinedGroup` | `{ membershipId, groupId, memberId, approvedById }` |
| `MemberLeftGroup` | `{ membershipId, groupId, memberId, exitedAt }` |
| `MembershipRejected` | `{ membershipId, groupId, memberId }` |

> **Why `GroupMembership` is a separate aggregate root** (not inside `Group`): there are no cross-membership invariants — no capacity limits, no minimum counts. Pulling memberships into `Group` would create an unbounded aggregate. See ADR-0001.

---

### `GroupAttendance`

Records attendance for a small group meeting session.

```typescript
class GroupAttendance {
  id: string;
  groupId: string; // reference to Group
  sessionDate: Date; // the date of the meeting
  presentMemberIds: string[]; // array of Member IDs present
  recordedById: string; // group leader who took attendance
  notes: string | null;
  recordedAt: Date;
}
```

**Invariants:**

- Only one `GroupAttendance` record per group per `sessionDate`
- All `presentMemberIds` must have an active (approved) `GroupMembership` for the group
- `sessionDate` must not be in the future

**Domain events published:**
| Event | Payload |
|---|---|
| `GroupAttendanceRecorded` | `{ attendanceId, groupId, sessionDate, presentCount }` |

---

## Value Objects

### `GroupType`

```typescript
type GroupType =
  | "cell_group"
  | "choir"
  | "youth"
  | "women"
  | "men"
  | "children"
  | "intercessory"
  | "ministry_team"
  | "other";
```

### `MembershipStatus`

```typescript
type MembershipStatus = "pending" | "approved" | "exited" | "rejected";
```

### `MemberRole`

```typescript
type MemberRole = "member" | "assistant_leader";
// 'leader' role is not stored on GroupMembership — it is on the Group aggregate itself
// This avoids the leader appearing twice in the membership list
```

---

## Cross-Context Integration

| Direction             | Event                 | Action                                                                                                                                    |
| --------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Produces              | `GroupLeaderAssigned` | Identity context reacts by assigning `MinistryLeader` role to new leader and revoking from previous leader (if they lead no other groups) |
| Produces              | `MemberLeftGroup`     | Consumed internally when a `Group` is deactivated                                                                                         |
| Consumes from Members | `MemberArchived`      | Automatically exit member from all groups — fires `MemberLeftGroup` for each active membership; vacate leader role if applicable          |
| Consumes from Members | `MemberReinstated`    | Does NOT restore previous memberships — member re-enrolls manually                                                                        |

---

## Deferred to Future Iterations

- Group capacity limits → would require pulling `GroupMembership` into `Group` aggregate; revisit ADR-0001 at that point
- Meeting schedule as a structured `RecurrenceRule` → currently free text
- Group-level communication (group-scoped announcements) → extend Communications context
- Sub-groups / nested groups → not modelled in MVP

---

## Decision Log

| Decision                                                  | Rationale                                                                                                                     |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `GroupMembership` is a separate aggregate root            | No capacity or cross-membership invariants in MVP; avoids unbounded aggregate. See ADR-0001.                                  |
| Leader role stored on `Group`, not as a `GroupMembership` | Avoids leader appearing in membership list as both leader and member; keeps leadership a first-class property of the group    |
| `MemberRole` only has `member` and `assistant_leader`     | Leader is always the `Group.leaderId`; `assistant_leader` is a courtesy role with no system permissions in MVP                |
| Reinstatement does not restore memberships                | Archival removes the member from all groups; reinstatement is rare and intentional — manual re-enrollment is the correct flow |
| `GroupAttendance` is a separate aggregate                 | One record per session per group; independent of both `Group` and `GroupMembership` lifecycles                                |
