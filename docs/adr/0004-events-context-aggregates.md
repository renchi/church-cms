# ADR-0004 — Events Bounded Context: Aggregates & Domain Model

**Date:** June 2026  
**Status:** Accepted  
**Linear:** CMS-3  
**Context:** Events bounded context

---

## Overview

The Events context owns the scheduling of all church activities and tracks who attended them. It references members by ID only. It publishes `AttendanceRecorded` which the Members context consumes to maintain a denormalised attendance summary.

---

## Aggregate Roots

### `ServiceEvent`

Represents a single church service or one-off event.

```typescript
class ServiceEvent {
  id: string;
  title: string; // e.g. "Sunday Morning Service", "Youth Camp 2026"
  eventType: EventType; // value object: service | event
  venue: Venue; // value object
  ministerId: string | null; // reference to Member (the presiding minister)
  scheduledAt: Date; // start date and time
  durationMinutes: number;
  status: EventStatus; // value object: scheduled | ongoing | completed | cancelled
  description: string | null;
  createdById: string;
  createdAt: Date;
}
```

**Invariants:**

- `scheduledAt` must be in the future when first created
- A `cancelled` event cannot transition back to `scheduled`
- `durationMinutes` must be greater than zero
- `ministerId` is optional — some events have no designated minister

**State machine — `EventStatus`:**

```
scheduled ──► ongoing ──► completed
     │
     └───────────────────► cancelled
```

**Domain events published:**
| Event | Payload |
|---|---|
| `EventCreated` | `{ eventId, title, eventType, scheduledAt, venue }` |
| `EventCancelled` | `{ eventId, cancelledAt, reason }` |
| `EventCompleted` | `{ eventId, completedAt }` |

---

### `Attendance`

Records a single member's presence at a specific event. Owned by Events — not Members (see ADR-0001 rationale).

```typescript
class Attendance {
  id: string;
  eventId: string; // reference to ServiceEvent
  memberId: string; // reference to Member
  checkedInAt: Date;
  checkedInById: string; // who recorded the check-in (self or admin)
  method: CheckInMethod; // value object: self | manual | qr_code
}
```

**Invariants:**

- A member can only have one `Attendance` record per event — duplicate check-ins are rejected
- `eventId` must reference a `ServiceEvent` with status `scheduled` or `ongoing`
- `checkedInAt` must not be more than 2 hours before the event's `scheduledAt`

**Domain events published:**
| Event | Payload |
|---|---|
| `AttendanceRecorded` | `{ attendanceId, eventId, memberId, checkedInAt }` |

---

### `VolunteerAssignment`

Assigns a member to a specific role for a specific event.

```typescript
class VolunteerAssignment {
  id: string;
  eventId: string; // reference to ServiceEvent
  memberId: string; // reference to Member
  role: VolunteerRole; // value object
  assignedById: string; // admin who made the assignment
  assignedAt: Date;
  confirmedAt: Date | null; // null = pending volunteer confirmation
  status: AssignmentStatus; // value object: pending | confirmed | declined
}
```

**Invariants:**

- A member can only hold one assignment per role per event
- A member can hold multiple different roles in the same event (e.g. worship + ushering)
- Assignments to a `cancelled` event are automatically moved to `declined`

**Domain events published:**
| Event | Payload |
|---|---|
| `VolunteerAssigned` | `{ assignmentId, eventId, memberId, role }` |
| `VolunteerConfirmed` | `{ assignmentId, eventId, memberId }` |
| `VolunteerDeclined` | `{ assignmentId, eventId, memberId }` |

---

## Value Objects

### `EventType`

```typescript
type EventType = "service" | "event";
// MVP: single aggregate covers both. Split if invariants diverge significantly.
// Signal to split: more than 2 if(eventType === 'x') branches in domain logic.
```

### `Venue`

```typescript
class Venue {
  name: string; // e.g. "Main Sanctuary", "Youth Hall", "Online"
  address: string | null;
  isOnline: boolean;
}
```

### `EventStatus`

```typescript
type EventStatus = "scheduled" | "ongoing" | "completed" | "cancelled";
```

### `CheckInMethod`

```typescript
type CheckInMethod = "self" | "manual" | "qr_code";
// qr_code check-in deferred to Phase 3
```

### `VolunteerRole`

```typescript
type VolunteerRole =
  | "worship_team"
  | "usher"
  | "media_tech"
  | "greeter"
  | "intercessor"
  | "children_ministry"
  | "other";
```

### `AssignmentStatus`

```typescript
type AssignmentStatus = "pending" | "confirmed" | "declined";
```

---

## Cross-Context Integration

| Direction             | Event                | Action                                                                          |
| --------------------- | -------------------- | ------------------------------------------------------------------------------- |
| Produces              | `AttendanceRecorded` | Members context consumes to update attendance summary                           |
| Produces              | `EventCreated`       | Communications context may consume to auto-generate reminders                   |
| Consumes from Members | `MemberArchived`     | Remove member from all future `VolunteerAssignment` records (set to `declined`) |

---

## Deferred to Future Iterations

- Recurring service schedules (`RecurrenceRule`) — Phase 2
- QR code check-in → `CheckInMethod.qr_code` already modelled, implementation deferred
- RSVP capacity limits on events → requires `EventCapacity` value object
- Online event streaming links → extend `Venue` with `streamUrl`

---

## Decision Log

| Decision                                                        | Rationale                                                                                                                          |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `Attendance` is a separate aggregate, not inside `ServiceEvent` | An event with 500 attendees would be an unbounded aggregate; each `Attendance` enforces its own uniqueness invariant independently |
| `eventType` as a VO on single aggregate                         | No diverging invariants between service and event in MVP; avoids premature split                                                   |
| `VolunteerAssignment` is a separate aggregate                   | Same reasoning as `Attendance` — one event can have many volunteers, no spanning invariants                                        |
