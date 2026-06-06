# ADR-0003 — Finance Bounded Context: Aggregates & Domain Model

**Date:** June 2026  
**Status:** Accepted  
**Linear:** CMS-3  
**Context:** Finance bounded context

---

## Overview

The Finance context owns all money flowing in and out of the church. It references members by ID only — it never imports or owns Member domain objects.

---

## Aggregate Roots

### `Offering`

Represents a single donation made by a member or anonymous donor.

```typescript
class Offering {
  id: string                    // UUID
  donorMemberId: string | null  // null = anonymous/walk-in donor
  amount: Money                 // value object
  givingType: GivingType        // value object: tithe | offering | special
  fundId: string                // reference to Fund aggregate
  channel: ChannelType          // value object: online | cash | cheque | transfer
  recordedAt: Date
  recordedById: string          // admin who recorded it
  transactionReference: string | null  // for online payments (Stripe ref)
}
```

**Invariants:**
- `amount.value` must be greater than zero
- `fundId` must reference an existing, active `Fund`
- `transactionReference` is required when `channel === 'online'`
- An `Offering` is immutable once recorded — corrections create a new `Offering` with a note, never edit the original

**Domain events published:**
| Event | Payload |
|---|---|
| `OfferingReceived` | `{ offeringId, donorMemberId, amount, fundId, givingType }` |

---

### `Fund`

Represents a named pool of money with a tracked balance.

```typescript
class Fund {
  id: string
  name: string                  // e.g. "General", "Building", "Missions"
  fundType: FundType            // value object: general | building | missions | youth | special
  balance: Money                // derived — sum of offerings minus expenses
  isActive: boolean
  createdAt: Date
}
```

**Invariants:**
- `name` must be unique across all funds
- An inactive `Fund` cannot receive new `Offering` records
- `balance` is never stored directly — it is always derived from `Offering` and `Expense` records via a read model

**Domain events published:**
| Event | Payload |
|---|---|
| `FundCreated` | `{ fundId, name, fundType }` |
| `FundDeactivated` | `{ fundId }` |

---

### `Expense`

Represents money paid out from a fund.

```typescript
class Expense {
  id: string
  amount: Money
  category: ExpenseCategory     // value object: utilities | salaries | events | maintenance | other
  description: string
  fundId: string                // which fund this is charged to
  approvedById: string          // admin who approved it
  receiptUrl: string | null     // optional supporting document
  incurredAt: Date
  recordedAt: Date
}
```

**Invariants:**
- `amount.value` must be greater than zero
- `fundId` must reference an existing, active `Fund`
- An `Expense` is immutable once recorded — same correction policy as `Offering`

**Domain events published:**
| Event | Payload |
|---|---|
| `ExpenseLogged` | `{ expenseId, amount, fundId, category }` |

---

## Value Objects

### `Money`
```typescript
class Money {
  amount: number   // stored in smallest currency unit (centavos/cents)
  currency: string // ISO 4217 — e.g. "PHP", "USD"
}
// Rules: amount must be integer >= 0; currency must be a valid ISO code
```

### `GivingType`
```typescript
type GivingType = 'tithe' | 'offering' | 'special'
// MVP: no pledge tracking. If pledge tracking is added, extract Tithe aggregate.
```

### `FundType`
```typescript
type FundType = 'general' | 'building' | 'missions' | 'youth' | 'special'
```

### `ChannelType`
```typescript
type ChannelType = 'online' | 'cash' | 'cheque' | 'transfer'
```

### `ExpenseCategory`
```typescript
type ExpenseCategory = 'utilities' | 'salaries' | 'events' | 'maintenance' | 'other'
```

---

## Domain Services

### `FundBalanceCalculator`
Calculates the current balance of a fund by summing all `Offering` amounts minus all `Expense` amounts for that fund. This is a read-model concern — never stored on the `Fund` aggregate itself.

### `GivingStatementGenerator`
Produces a year-end giving statement for a member by querying all `Offering` records with a matching `donorMemberId` within a date range. Returns a PDF-ready data structure.

---

## Cross-Context Integration

| Direction | Event | Action |
|---|---|---|
| Consumes from Members | `MemberArchived` | Flag all `Offering` records for that `donorMemberId` as orphaned — do not delete |
| Produces | `OfferingReceived` | Consumed by no context in Phase 1; reserved for Phase 3 analytics |

---

## Deferred to Future Iterations

- Pledge tracking and tithe commitment analysis → will introduce `Tithe` aggregate if needed
- Budget planning per fund → `Budget` aggregate
- Multi-currency support → `Money` already supports `currency` field
- Stripe webhook reconciliation → `PaymentReconciliation` domain service

---

## Decision Log

| Decision | Rationale |
|---|---|
| `balance` is derived, not stored | Prevents balance drift bugs; always computed from source records |
| Offerings are immutable | Financial audit trail integrity — corrections are new records, not edits |
| Single `Offering` aggregate for tithes and offerings | No pledge invariants in MVP; `GivingType` VO captures the distinction |
