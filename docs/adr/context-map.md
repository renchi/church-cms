# Context Map — Church CMS

**Version:** 1.0  
**Status:** Draft  
**Phase:** 1 — DDD Foundation  
**Last updated:** June 2026

---

## Overview

This document defines the bounded contexts of the Church CMS system, their responsibilities, domain types, and the relationships between them. It serves as the authoritative reference for where each piece of domain logic lives and how contexts communicate across boundaries.

The system is decomposed into **six bounded contexts**. Each context owns its data exclusively — no context reads another's database directly. Cross-context communication happens through published domain events (async) or API calls (sync), using only stable, minimal references (IDs) rather than full objects.

---

## Bounded Contexts

### 1. Members (Core Domain)

> The heart of the system. This context owns everything about who a person is within the church community.

**Responsibilities:**

- Member registration, profile management, and lifecycle (active → inactive → archived)
- Family unit grouping and household relationships
- Member directory and search
- Maintains a denormalised attendance summary (total count, last seen date) by consuming `AttendanceRecorded` events from the Events context

**Aggregate roots:** `Member`

> `Family` is **not modelled as an aggregate root in the MVP**. A member carries a nullable `familyId` (a plain string/UUID). A "family" is purely a read model — a query grouping all members sharing the same `familyId`. There is no `Family` repository, no `Family` domain object, and no household-level invariants enforced.
>
> **Evolution path:** if household-level rules emerge (joint giving statements, head-of-household approval, family communication preferences), introduce a `Family` aggregate at that point with its own repository. The migration cost is low — `familyId` is already on `Member`, so adding the aggregate later does not require a data migration, only a new table and repository.

**Value objects:** `Email`, `PhoneNumber`, `Address`, `MemberStatus`, `MembershipDate`

> `MemberStatus` has three states with the following allowed transitions:
>
> | From       | To         | Event fired           | Who can trigger                                           |
> | ---------- | ---------- | --------------------- | --------------------------------------------------------- |
> | `active`   | `inactive` | `MemberStatusChanged` | `ChurchAdmin`, `SuperAdmin`                               |
> | `active`   | `archived` | `MemberArchived`      | `SuperAdmin` only                                         |
> | `inactive` | `active`   | `MemberStatusChanged` | `ChurchAdmin`, `SuperAdmin`                               |
> | `inactive` | `archived` | `MemberArchived`      | `SuperAdmin` only                                         |
> | `archived` | `active`   | `MemberReinstated`    | `SuperAdmin` only — rare, requires explicit justification |
>
> Archival is not a terminal state but is treated as near-terminal. Reinstatement from `archived` is permitted only by a `SuperAdmin` and should be an intentional, audited action. All other transitions are disallowed and must throw a domain error.

**Domain events published:**
| Event | Triggered when |
|---|---|
| `MemberRegistered` | A new member profile is created |
| `MemberContactUpdated` | Email, phone, or address changed |
| `MemberStatusChanged` | `active` ↔ `inactive` transition |
| `MemberNameChanged` | Legal name corrected |
| `MemberArchived` | A member is soft-deleted (active/inactive → archived) |
| `MemberReinstated` | An archived member is restored to active — SuperAdmin only |
| `MemberFamilyAssigned` | A member's `familyId` is set or changed |

**Domain events consumed:**
| Event | Source | Why |
|---|---|---|
| `AttendanceRecorded` | Events | Updates the member's denormalised attendance summary |

**What this context does NOT own:**

- Authentication credentials (owned by Identity)
- Offering records (owned by Finance)
- Group memberships (owned by Groups)

---

### 2. Identity (Generic Subdomain)

> A solved problem. Use an off-the-shelf solution (Clerk, Auth.js, or Supabase Auth) rather than building this from scratch. The church CMS consumes Identity as a service.

**Responsibilities:**

- User authentication (email/password, social login, 2FA)
- Role assignment: `SuperAdmin`, `ChurchAdmin`, `MinistryLeader`, `Member`
- Session management and token issuance
- Permission enforcement at the API gateway level

**Aggregate roots:** `User`, `Role`

**Value objects:** `AccessToken`, `Permission`, `RoleType`

**Domain events published:**
| Event | Triggered when |
|---|---|
| `UserRegistered` | A new login account is created |
| `RoleAssigned` | A user's role changes |
| `SessionRevoked` | A user is logged out or banned |

**Relationship to Members:**
Identity and Members are separate contexts deliberately. A `User` (login account) maps 1-to-1 with a `Member` (person), but they are different things. A person can exist as a Member without a login account (e.g. a child or elderly member added by staff). The `memberId` is stored on the `User` as a reference; the Members context does not know about Users.

**Implementation note:** Use an external provider (Clerk or Supabase Auth) for this context. Build a thin adapter layer (`IdentityService`) in your codebase that wraps the provider's API, so you can swap providers without changing domain logic.

---

### 3. Finance (Supporting Subdomain)

> Tracks all money flowing in and out of the church. Consumes member references from the Members context but owns all financial records independently.

**Responsibilities:**

- Online and manual offering/tithe recording
- Fund management (General, Building, Missions, etc.)
- Expense tracking and categorisation
- Year-end giving statement generation
- Fund balance summaries and financial reports

**Aggregate roots:** `Offering`, `Fund`, `Expense`

> `Offering` covers all forms of giving — tithes, regular offerings, and special gifts. The distinction is captured by a `GivingType` value object (`tithe | offering | special`) on the `Offering` aggregate. Pledge tracking and tithe commitment analysis are deferred to Phase 3; if they become a requirement, `Tithe` may be extracted as a separate aggregate at that point.

**Value objects:** `Money`, `GivingType`, `FundType`, `GivingPeriod`, `TransactionReference`

**Domain events published:**
| Event | Triggered when |
|---|---|
| `OfferingReceived` | A donation is recorded |
| `FundCreated` | A new fund is set up |
| `ExpenseLogged` | An expense is recorded against a fund |
| `GivingStatementGenerated` | A year-end statement is produced |

**Cross-context references:**

- Stores `donorMemberId` (from Members) on each `Offering` — never the full `Member` object
- Does not call the Members context in real time; resolves member names at report generation time via a read-model query

**Integration point:** Listens to `MemberArchived` from Members to flag orphaned giving records for review.

---

### 4. Events (Supporting Subdomain)

> Manages the scheduling of all church activities and tracks who attended them.

**Responsibilities:**

- Service and event creation, editing, and cancellation
- Recurring schedule management (e.g. every Sunday 9AM)
- Volunteer role assignment per event
- Attendance check-in and reporting per event
- Public calendar exposure

**Aggregate roots:** `ServiceEvent`, `Attendance`, `VolunteerAssignment`

> `ServiceEvent` covers both recurring worship services and one-off events. The distinction is captured by an `eventType` value object (`service | event`). In the MVP there are no invariants that differ between the two types. If type-specific rules emerge (recurrence rules for services, RSVP capacity for events), add them as nullable value objects guarded by `eventType`. If conditional logic on `eventType` appears in more than one or two places in the domain, that is the signal to split into separate `Service` and `Event` aggregates.

**Value objects:** `eventType`, `Venue`, `EventStatus`

> `RecurrenceRule` and `EventSchedule` are deferred to a future iteration. In the MVP, recurring services are created as individual `ServiceEvent` instances. Recurrence logic is introduced when the scheduling feature is explicitly prioritised.

**Domain events published:**
| Event | Triggered when |
|---|---|
| `EventCreated` | A new service or event is scheduled |
| `EventCancelled` | An event is cancelled |
| `AttendanceRecorded` | A member checks in to an event |
| `VolunteerAssigned` | A member is assigned to a service role |

**Cross-context references:**

- Stores `memberId` references on `Attendance` and `VolunteerAssignment`
- Listens to `MemberArchived` from Members to remove the member from future volunteer schedules

**Integration point:** Publishes `AttendanceRecorded` which the Members context consumes to update a member's denormalised attendance summary (total count, last seen date).

---

### 5. Communications (Supporting Subdomain)

> Handles all outbound messaging and community engagement features. Member data is referenced but never owned here.

**Responsibilities:**

- Email broadcast composition and delivery (bulk and targeted)
- SMS notification dispatch
- Announcement board management (publish, pin, archive)
- Prayer request submission, moderation, and sharing

**Aggregate roots:** `Announcement`, `PrayerRequest`, `MessageCampaign`

**Value objects:** `MessageBody`, `RecipientGroup`, `DeliveryStatus`, `VisibilityLevel`

> `RecipientGroup` is a criteria value object — it holds the selection spec (e.g. `{ type: 'active-members' }` or `{ type: 'group', groupId: '...' }`). A `RecipientResolver` **domain service** executes the query against the Members context at campaign-send time and returns a transient list of `{ memberId, email, name }` records. The value object itself never holds the resolved list.

> `VisibilityLevel` on `PrayerRequest` has exactly three valid states:
>
> - `private` — visible only to pastoral staff
> - `members-only` — visible to all logged-in members, requester name shown
> - `members-anonymous` — visible to all logged-in members, requester name hidden
>
> **Moderation rule:** all requests default to `private` on submission. A pastor promotes them to `members-only` or `members-anonymous`. The submitter may change the visibility of their own request at any time after submission, but cannot bypass the `private` default on first creation.

**Domain services:** `RecipientResolver`

**Domain events published:**
| Event | Triggered when |
|---|---|
| `AnnouncementPublished` | An announcement goes live |
| `PrayerRequestSubmitted` | A member submits a prayer request |
| `MessageCampaignSent` | A bulk email or SMS is dispatched |

**Cross-context references:**

- `RecipientResolver` (domain service) calls the Members context at campaign-send time to resolve a `RecipientGroup` criteria spec into a flat `{ memberId, email, name }` list
- Stores `requesterId` (from Members) on `PrayerRequest` for pastoral follow-up

**Integration point:** Listens to `EventCreated` from Events to optionally auto-generate event reminder campaigns.

---

### 6. Groups (Supporting Subdomain)

> Manages the sub-communities within the church — cell groups, choirs, ministry teams, and so on.

**Responsibilities:**

- Group creation and lifecycle management
- Member enrollment requests and leader approvals
- Group-level attendance tracking
- Leader assignment and rotation

**Aggregate roots:** `Group`, `GroupMembership`

> `GroupMembership` is intentionally a separate aggregate root, not an entity inside `Group`. There are no cross-membership invariants (no capacity limits, no minimum leader count, no uniqueness enforced at the group level), so pulling memberships into the `Group` aggregate would create an unbounded aggregate that grows with every enrollment. Each `GroupMembership` enforces only its own state transitions: `Pending → Approved → Exited`.

**Value objects:** `GroupType`, `MembershipStatus`, `LeaderRole`

**Domain events published:**
| Event | Triggered when |
|---|---|
| `GroupCreated` | A new group is formed |
| `MemberJoinedGroup` | Enrollment is approved |
| `MemberLeftGroup` | A member exits a group |
| `GroupLeaderAssigned` | A new leader is appointed for a group |

**Domain events consumed:**
| Event | Source | Why |
|---|---|---|
| `MemberArchived` | Members | Remove the member from all groups and vacate any leader role |
| `MemberReinstated` | Members | Does **not** automatically restore previous group memberships — the member re-enrolls manually. If the reinstated member was a group leader, the leader slot is not automatically restored either. |

**Cross-context references:**

- Stores `memberId` and `leaderId` (both opaque references from Members) on `Group`
- Identity context listens to `GroupLeaderAssigned` and reactively assigns the `MinistryLeader` role to the user — Groups does not call Identity directly

> Leader assignment is a business act that originates in Groups ("Maria leads Young Adults"). The Identity role is an infrastructural consequence, not the cause. If the `MinistryLeader` role needs to be revoked, that too is triggered by a Groups event (`GroupLeaderAssigned` with a new leader, or `MemberLeftGroup` for the outgoing leader).

---

## Context Relationships

```
┌─────────────────────────────────────────────────────────┐
│                    RELATIONSHIP MAP                      │
└─────────────────────────────────────────────────────────┘

  Identity ──── authenticates ────► Members (upstream)
                                         │
                    ┌────────────────────┼────────────────────┐
                    │                    │                    │
                    ▼                    ▼                    ▼
               Finance             Events              Communications
               (donorId)         (attendeeId,          (recipientId,
                                  volunteerId)          requesterId)
                                         │
                                         ▼
                                       Groups
                                     (memberId,
                                      leaderId)
```

### Relationship types

| Upstream context | Downstream context | Relationship type | Integration                                                               |
| ---------------- | ------------------ | ----------------- | ------------------------------------------------------------------------- |
| Identity         | Members            | Customer/Supplier | Identity issues tokens; Members validates them via middleware             |
| Members          | Finance            | Customer/Supplier | Finance stores `memberId` reference; queries Members read-model for names |
| Members          | Events             | Customer/Supplier | Events stores `memberId` on Attendance and VolunteerAssignment            |
| Members          | Communications     | Customer/Supplier | Comms queries Members for recipient lists                                 |
| Members          | Groups             | Customer/Supplier | Groups stores `memberId` and `leaderId` references                        |
| Events           | Communications     | Customer/Supplier | Comms listens to `EventCreated` to generate reminders                     |

### Integration patterns used

**Synchronous (REST/tRPC):** Used when a context needs data from another at request time — e.g. Communications resolving a recipient list from Members before sending a campaign.

**Asynchronous (Domain Events via message bus):** Used for reactions to state changes — e.g. Groups consuming `MemberArchived` to clean up memberships. In Phase 1 this is simulated via direct service calls; in Phase 2 it will be wired through RabbitMQ/NATS.

---

## Anti-corruption Layer (ACL) Guidelines

Every integration point between contexts must go through a dedicated interface — never import domain objects from another context directly.

```
// ✅ Correct — reference by ID only
class Offering {
  donorMemberId: string   // opaque reference, not a Member object
  amount: Money
  fund: Fund
}

// ❌ Wrong — importing another context's aggregate
import { Member } from '../members/domain/Member'
class Offering {
  donor: Member           // creates tight coupling, breaks context boundary
}
```

When a context needs to display data from another context (e.g. Finance showing a donor's name on a report), it uses a **read model** — a denormalised query that joins across services at the infrastructure layer, not the domain layer.

---

## Decision Log

| Date      | Decision                                                         | Rationale                                                                                                                                                                                                                                    |
| --------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| June 2026 | Identity implemented via external provider (Clerk/Supabase Auth) | Generic subdomain — not worth building custom auth                                                                                                                                                                                           |
| June 2026 | Members is the single source of truth for person identity        | Every other context references a `memberId`, never duplicates person data                                                                                                                                                                    |
| June 2026 | Phase 1 uses synchronous HTTP between contexts                   | Simpler for learning; async message bus (RabbitMQ) introduced in Phase 2                                                                                                                                                                     |
| June 2026 | Finance does not call Members in real time                       | Avoids runtime coupling; member names resolved at report time via read model                                                                                                                                                                 |
| June 2026 | MVP design principle: model only what has known invariants today | Features likely to change are implemented as the simplest possible structure (e.g. `familyId` field instead of `Family` aggregate) with a documented evolution path. Complexity is introduced only when a concrete business rule demands it. |

---

## Next Steps

With this context map complete, the following issues are now unblocked:

- **CMS-2** — Design Member aggregate & domain events (go deep on the core domain)
- **CMS-3** — Design aggregates for Finance, Events, Comms & Groups (apply the same rigour to supporting contexts)

Once CMS-2 and CMS-3 are done, save this document to your repo at `docs/adr/context-map.md` and update CMS-1 status to **Done** in Linear and Notion.
