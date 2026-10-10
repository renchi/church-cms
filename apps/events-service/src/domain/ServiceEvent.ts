import { randomUUID } from "crypto";
import { DomainError } from "./errors.js";
import type { EventCancelledEvent, EventCreatedEvent, EventUpdatedEvent } from "./events.js";

// ADR-0004: one aggregate covers both regular services and one-off events.
// Signal to split it: more than two `if (eventType === ...)` branches in the
// domain logic. Today there are none.
export type EventType = "service" | "event";
export const EVENT_TYPES: readonly EventType[] = ["service", "event"];

// scheduled ──► ongoing ──► completed
//      └──────────────────► cancelled
// Only "scheduled" and "cancelled" are reachable through the API so far; the
// start/complete transitions arrive with the ticket that needs them.
export type EventStatus = "scheduled" | "ongoing" | "completed" | "cancelled";

export interface VenueProps {
  name: string;
  address: string | null;
  isOnline: boolean;
}

// A value object: defined entirely by its values, with no id of its own, and
// immutable. Two Venues with the same name/address/isOnline ARE the same venue.
// To "change" a venue you replace it with a new one, which is why it has no
// setters. Its validation lives here, so an invalid Venue can never exist.
export class Venue {
  private constructor(private readonly props: VenueProps) {}

  static create(params: { name: string; address?: string | null; isOnline?: boolean }): Venue {
    const name = params.name.trim();
    if (!name) throw new DomainError("Venue name is required");
    return new Venue({
      name,
      address: params.address?.trim() || null,
      isOnline: params.isOnline ?? false,
    });
  }

  get name() {
    return this.props.name;
  }
  get address() {
    return this.props.address;
  }
  get isOnline() {
    return this.props.isOnline;
  }

  equals(other: Venue): boolean {
    return (
      this.name === other.name && this.address === other.address && this.isOnline === other.isOnline
    );
  }

  toProps(): VenueProps {
    return { ...this.props };
  }
}

export interface ServiceEventSnapshot {
  id: string;
  title: string;
  eventType: EventType;
  venue: VenueProps;
  ministerId: string | null;
  scheduledAt: Date;
  durationMinutes: number;
  status: EventStatus;
  description: string | null;
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
  // Optimistic concurrency: how many times this event has been saved. 0 means
  // "new, never saved". The repository only writes if the stored version still
  // matches, so a request working on a stale copy fails instead of silently
  // overwriting a newer change (e.g. an edit undoing a cancellation).
  version: number;
}

export interface ScheduleEventParams {
  title: string;
  eventType: EventType;
  venue: { name: string; address?: string | null; isOnline?: boolean };
  ministerId?: string | null;
  scheduledAt: Date;
  durationMinutes: number;
  description?: string | null;
  createdById: string;
}

export interface UpdateEventParams {
  title?: string;
  eventType?: EventType;
  venue?: { name: string; address?: string | null; isOnline?: boolean };
  ministerId?: string | null;
  scheduledAt?: Date;
  durationMinutes?: number;
  description?: string | null;
}

function requireTitle(title: string): string {
  const trimmed = title.trim();
  if (!trimmed) throw new DomainError("Title is required");
  return trimmed;
}

function requireDuration(minutes: number): number {
  if (!Number.isInteger(minutes) || minutes <= 0) {
    throw new DomainError("Duration must be a whole number of minutes greater than zero");
  }
  return minutes;
}

function requireValidDate(date: Date): Date {
  if (Number.isNaN(date.getTime())) throw new DomainError("Invalid date");
  return date;
}

// ADR-0004: "scheduledAt must be in the future when first created". The same
// rule applies when an event is moved: rescheduling into the past would make it
// vanish from the upcoming list and open check-in immediately.
function requireFutureDate(date: Date, now: Date): Date {
  if (requireValidDate(date).getTime() <= now.getTime()) {
    throw new DomainError("An event must be scheduled in the future");
  }
  return date;
}

export class ServiceEvent {
  private constructor(private snap: ServiceEventSnapshot) {}

  get id() {
    return this.snap.id;
  }
  get title() {
    return this.snap.title;
  }
  get eventType() {
    return this.snap.eventType;
  }
  get venue(): Venue {
    return Venue.create(this.snap.venue);
  }
  get ministerId() {
    return this.snap.ministerId;
  }
  get scheduledAt() {
    return this.snap.scheduledAt;
  }
  get durationMinutes() {
    return this.snap.durationMinutes;
  }
  get status() {
    return this.snap.status;
  }
  get description() {
    return this.snap.description;
  }
  get createdById() {
    return this.snap.createdById;
  }
  get version() {
    return this.snap.version;
  }

  // `now` is a parameter (defaulting to the real clock) so tests can pin time.
  // "In the future" is a rule about time, and tests that depend on the real
  // clock break at midnight, on slow machines, or in another timezone.
  static schedule(
    params: ScheduleEventParams,
    now: Date = new Date()
  ): { event: ServiceEvent; domainEvent: EventCreatedEvent } {
    const title = requireTitle(params.title);
    const venue = Venue.create(params.venue);
    const scheduledAt = requireFutureDate(params.scheduledAt, now);
    const durationMinutes = requireDuration(params.durationMinutes);
    if (!params.createdById.trim()) throw new DomainError("createdById is required");

    const event = new ServiceEvent({
      id: randomUUID(),
      title,
      eventType: params.eventType,
      venue: venue.toProps(),
      ministerId: params.ministerId?.trim() || null,
      scheduledAt,
      durationMinutes,
      status: "scheduled",
      description: params.description?.trim() || null,
      createdById: params.createdById.trim(),
      createdAt: now,
      updatedAt: now,
      version: 0,
    });

    return {
      event,
      domainEvent: {
        type: "EventCreated",
        eventId: event.id,
        title: event.title,
        eventType: event.eventType,
        scheduledAt: event.scheduledAt,
        venue: venue.toProps(),
        occurredAt: now,
      },
    };
  }

  update(params: UpdateEventParams, now: Date = new Date()): EventUpdatedEvent {
    if (this.snap.status === "cancelled") throw new DomainError("Cannot update a cancelled event");
    if (this.snap.status === "completed") throw new DomainError("Cannot update a completed event");

    // Validate everything first, then apply: a half-applied update would leave
    // the aggregate in a state nobody asked for.
    const next = { ...this.snap };
    if (params.title !== undefined) next.title = requireTitle(params.title);
    if (params.eventType !== undefined) next.eventType = params.eventType;
    if (params.venue !== undefined) next.venue = Venue.create(params.venue).toProps();
    if (params.ministerId !== undefined) next.ministerId = params.ministerId?.trim() || null;
    if (params.scheduledAt !== undefined) {
      next.scheduledAt = requireFutureDate(params.scheduledAt, now);
    }
    if (params.durationMinutes !== undefined) {
      next.durationMinutes = requireDuration(params.durationMinutes);
    }
    if (params.description !== undefined) next.description = params.description?.trim() || null;
    next.updatedAt = now;

    this.snap = next;
    return { type: "EventUpdated", eventId: this.id, occurredAt: now };
  }

  cancel(reason: string, now: Date = new Date()): EventCancelledEvent {
    // ADR-0004: a cancelled event cannot go back to scheduled, and the state
    // machine has no path from "completed" to "cancelled" either.
    if (this.snap.status === "cancelled") throw new DomainError("Event is already cancelled");
    if (this.snap.status === "completed") throw new DomainError("Cannot cancel a completed event");
    const trimmed = reason.trim();
    if (!trimmed) throw new DomainError("A cancellation reason is required");

    this.snap.status = "cancelled";
    this.snap.updatedAt = now;
    return {
      type: "EventCancelled",
      eventId: this.id,
      cancelledAt: now,
      reason: trimmed,
      occurredAt: now,
    };
  }

  // Asked by the Attendance aggregate (ADR-0004: check-in needs a "scheduled"
  // or "ongoing" event). The event answers the question about its own state,
  // instead of other code reading `status` and re-implementing the rule.
  isOpenForCheckIn(): boolean {
    return this.snap.status === "scheduled" || this.snap.status === "ongoing";
  }

  acceptsVolunteers(): boolean {
    return this.snap.status === "scheduled" || this.snap.status === "ongoing";
  }

  toSnapshot(): ServiceEventSnapshot {
    return { ...this.snap, venue: { ...this.snap.venue } };
  }

  static reconstitute(snapshot: ServiceEventSnapshot): ServiceEvent {
    return new ServiceEvent({ ...snapshot, venue: { ...snapshot.venue } });
  }
}
