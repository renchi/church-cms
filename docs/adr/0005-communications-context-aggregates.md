# ADR-0005 — Communications Bounded Context: Aggregates & Domain Model

**Date:** June 2026  
**Status:** Accepted  
**Linear:** CMS-3  
**Context:** Communications bounded context

---

## Overview

The Communications context handles all outbound messaging and community engagement. It references members by ID for authorship and prayer requests. Recipient lists are resolved at send-time via the `RecipientResolver` domain service — never stored as Member objects.

---

## Aggregate Roots

### `Announcement`

A published church notice visible on the member-facing announcement board.

```typescript
class Announcement {
  id: string;
  title: string;
  body: MessageBody; // value object
  authorId: string; // reference to Member (the admin who wrote it)
  status: AnnouncementStatus; // value object: draft | published | archived
  isPinned: boolean; // pinned announcements appear at top of board
  publishedAt: Date | null; // null when status is draft
  archivedAt: Date | null;
  createdAt: Date;
}
```

**Invariants:**

- An `archived` announcement cannot be re-published
- A `pinned` announcement must have `status === 'published'`
- Only one announcement can be pinned at a time — pinning a new one unpins the previous

**State machine — `AnnouncementStatus`:**

```
draft ──► published ──► archived
```

**Domain events published:**
| Event | Payload |
|---|---|
| `AnnouncementPublished` | `{ announcementId, title, authorId, isPinned }` |
| `AnnouncementArchived` | `{ announcementId }` |

---

### `PrayerRequest`

A prayer need submitted by a member for pastoral attention or community prayer.

```typescript
class PrayerRequest {
  id: string;
  content: string;
  requesterId: string; // reference to Member who submitted it
  visibility: VisibilityLevel; // value object: private | members-only | members-anonymous
  status: PrayerRequestStatus; // value object: pending | active | answered | closed
  submittedAt: Date;
  reviewedById: string | null; // pastor who reviewed and promoted it
  reviewedAt: Date | null;
}
```

**Invariants:**

- All requests default to `visibility: 'private'` on submission — cannot be overridden by the submitter on creation
- Only a `ChurchAdmin` or `SuperAdmin` can promote visibility to `members-only` or `members-anonymous`
- The submitter can change their own request's visibility at any time after submission
- An `answered` or `closed` request cannot change visibility

**State machine — `PrayerRequestStatus`:**

```
pending ──► active ──► answered
                  └──► closed
```

**VisibilityLevel states:**
| Level | Visible to | Name shown |
|---|---|---|
| `private` | Pastoral staff only | Yes |
| `members-only` | All logged-in members | Yes |
| `members-anonymous` | All logged-in members | Hidden |

**Domain events published:**
| Event | Payload |
|---|---|
| `PrayerRequestSubmitted` | `{ requestId, requesterId, visibility }` |
| `PrayerRequestPromoted` | `{ requestId, newVisibility, reviewedById }` |
| `PrayerRequestAnswered` | `{ requestId }` |

---

### `MessageCampaign`

A bulk email or SMS broadcast sent to a defined recipient group.

```typescript
class MessageCampaign {
  id: string;
  channel: BroadcastChannel; // value object: email | sms
  subject: string | null; // required for email, null for SMS
  body: MessageBody; // value object
  recipientGroup: RecipientGroup; // value object — criteria spec, not resolved list
  status: CampaignStatus; // value object: draft | sending | sent | failed
  scheduledAt: Date | null; // null = send immediately
  sentAt: Date | null;
  sentById: string; // admin who triggered the send
  recipientCount: number | null; // populated after send
  createdAt: Date;
}
```

**Invariants:**

- `subject` is required when `channel === 'email'`
- A `sent` campaign is immutable
- `body` length must not exceed 160 characters when `channel === 'sms'`
- A `failed` campaign can be retried — creates a new `MessageCampaign`, does not mutate the original

**State machine — `CampaignStatus`:**

```
draft ──► sending ──► sent
               └────► failed
```

**Domain events published:**
| Event | Payload |
|---|---|
| `MessageCampaignSent` | `{ campaignId, channel, recipientCount, sentAt }` |
| `MessageCampaignFailed` | `{ campaignId, reason }` |

---

## Value Objects

### `MessageBody`

```typescript
class MessageBody {
  content: string;
  format: "plain" | "html"; // SMS always plain; email supports html
}
// Rules: content must not be empty; html format only allowed for email channel
```

### `RecipientGroup`

```typescript
class RecipientGroup {
  type: "all-members" | "active-members" | "group" | "custom-list";
  groupId: string | null; // required when type === 'group'
  memberIds: string[] | null; // required when type === 'custom-list'
}
// This is a CRITERIA spec — resolved at send-time by RecipientResolver domain service
// The value object never holds the actual resolved member list
```

### `BroadcastChannel`

```typescript
type BroadcastChannel = "email" | "sms";
```

### `VisibilityLevel`

```typescript
type VisibilityLevel = "private" | "members-only" | "members-anonymous";
```

### `AnnouncementStatus`

```typescript
type AnnouncementStatus = "draft" | "published" | "archived";
```

### `PrayerRequestStatus`

```typescript
type PrayerRequestStatus = "pending" | "active" | "answered" | "closed";
```

### `CampaignStatus`

```typescript
type CampaignStatus = "draft" | "sending" | "sent" | "failed";
```

---

## Domain Services

### `RecipientResolver`

Resolves a `RecipientGroup` criteria spec into a flat list of `{ memberId, email, name, phone }` by calling the Members context API at send-time. Returns a transient list — never persisted on the `MessageCampaign`.

```typescript
interface RecipientResolver {
  resolve(group: RecipientGroup): Promise<RecipientRecord[]>;
}

interface RecipientRecord {
  memberId: string;
  email: string;
  name: string;
  phone: string | null;
}
```

---

## Cross-Context Integration

| Direction            | Event                 | Action                                                                            |
| -------------------- | --------------------- | --------------------------------------------------------------------------------- |
| Consumes from Events | `EventCreated`        | Optionally auto-generates a `MessageCampaign` draft for event reminders (Phase 2) |
| Calls Members (sync) | —                     | `RecipientResolver` queries Members API at campaign send-time                     |
| Produces             | `MessageCampaignSent` | No consumers in Phase 1 — reserved for Phase 3 analytics                          |

---

## Deferred to Future Iterations

- Email delivery provider integration (SendGrid / Resend) → Phase 2
- SMS provider integration (Twilio) → Phase 2
- Delivery receipts and open tracking → `DeliveryStatus` already modelled
- Auto-generated event reminder campaigns → Phase 2
- Push notification channel → extend `BroadcastChannel`

---

## Decision Log

| Decision                                                           | Rationale                                                                 |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `RecipientGroup` is a criteria VO, not a stored list               | Prevents stale recipient data; list is always resolved fresh at send-time |
| `RecipientResolver` is a domain service, not part of any aggregate | It crosses a context boundary — cannot be an aggregate method             |
| `PrayerRequest` visibility defaults to `private`                   | Pastoral moderation protects member privacy before content goes public    |
| Failed campaigns create new records, not mutations                 | Audit trail integrity — same immutability principle as Finance offerings  |

---

## Addendum (CMS-20, November 2026): the welcome email

**Status:** Accepted

Communications became Active with one slice: a member who registers gets a welcome email.
Members has published a thin `MemberRegistered { memberId }` since CMS-27, with no
consumer until now. The decisions below came out of a design session with the user
(recorded on CMS-20); the vocabulary is in
[`apps/communications-service/GLOSSARY.md`](../../apps/communications-service/GLOSSARY.md).

### Decision

- **A fourth aggregate, `WelcomeEmail`** (`memberId`, `status: sent | skipped`,
  `decidedAt`), beside the three above. A welcome email is a *transactional message*
  (one person, caused by their own action), not a campaign: modelling it as a
  one-recipient `MessageCampaign` would blur what a campaign is. One per member, ever,
  enforced by the database (`memberId` is the primary key), so a second
  `MemberRegistered` for the same member can't lead to a second email.
- **At-least-once sending: send first, then record.** An email can't be rolled back, so
  a crash between the send and the record must go one way or the other. Sending first
  can repeat a welcome (on redelivery); recording first can lose one. A duplicate
  welcome is harmless and a lost one goes unnoticed, so we accept duplicates.
- **A member archived before the email goes out is skipped**, and the `WelcomeEmail` is
  recorded as `skipped`: welcoming someone already archived is wrong, and recording the
  decision keeps "every registration got an answer" visible.
- **`RecipientResolver` gains `resolveMember(memberId)`** for one recipient, beside the
  planned `resolve(group)`. Same concept, same name; the adapter calls
  `GET /members/:id`. Members answering 404 means something is broken (Members never
  deletes), so the message is terminated, not retried; Members being unavailable means
  retry with backoff.
- **The provider is SMTP to Mailpit**, a test mail server in the cluster, behind an
  `EmailSender` port. Resend (above, "Deferred") is a later adapter, not a redesign.
- **The consumer starts at "now"** (`DeliverPolicy.New`): members registered before
  Communications existed get no late welcome email.
- **No outbound event, no outbox.** Nothing consumes `WelcomeEmailSent` yet.

### Consequences

**Good:** the first consumer of a thin event, showing the lookup it implies; a side
effect that can't be rolled back, with its trade-off written down; Communications runs
through the same plumbing (`@cms/events` consumer, metrics, `EventDeliveryStalled`) as
the other services.

**Costs:** a welcome email depends on Members being up (it waits and retries, it isn't
lost). A rare duplicate email is possible by design. The lookup has no authentication
until Identity exists.

| Now (after this addendum) | Trigger | Then |
| --- | --- | --- |
| SMTP to Mailpit | Real members should get real mail | A provider adapter (Resend), credentials from a Secret, its idempotency key to narrow the duplicate window |
| Lookup over HTTP at send time | Members' availability holds welcome emails up too often | A local read model of members, built from Members' events (a copy of person data: weigh it) |
| Plain text only | Someone asks for a designed email | `MessageBody` `html`, and a template |
| No outbound event | Another context needs to know a welcome email went out | `WelcomeEmailSent` in `@cms/events`, plus an outbox in this service |
