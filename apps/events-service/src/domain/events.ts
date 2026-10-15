// Domain events: facts about something that already happened in this context,
// named in the past tense. Payloads follow ADR-0004.
//
// The aggregates RETURN these; they never publish anything. The one another
// context consumes, AttendanceRecorded (→ Members), is handed to the
// repository, saved to the outbox in the same transaction, and published to
// NATS by the outbox relay (ADR-0010). Its WIRE shape is a separate type in
// @cms/events (AttendanceRecordedV1), mapped in infrastructure/outbox.ts, so
// this internal type can change without breaking Members.
import type { EventType, VenueProps } from "./ServiceEvent.js";
import type { VolunteerRole } from "./VolunteerAssignment.js";

export interface EventCreatedEvent {
  type: "EventCreated";
  eventId: string;
  title: string;
  eventType: EventType;
  scheduledAt: Date;
  venue: VenueProps;
  occurredAt: Date;
}

export interface EventUpdatedEvent {
  type: "EventUpdated";
  eventId: string;
  occurredAt: Date;
}

export interface EventCancelledEvent {
  type: "EventCancelled";
  eventId: string;
  cancelledAt: Date;
  reason: string;
  occurredAt: Date;
}

export interface AttendanceRecordedEvent {
  type: "AttendanceRecorded";
  attendanceId: string;
  eventId: string;
  memberId: string;
  checkedInAt: Date;
  occurredAt: Date;
}

export interface VolunteerAssignedEvent {
  type: "VolunteerAssigned";
  assignmentId: string;
  eventId: string;
  memberId: string;
  role: VolunteerRole;
  occurredAt: Date;
}

export interface VolunteerDeclinedEvent {
  type: "VolunteerDeclined";
  assignmentId: string;
  eventId: string;
  memberId: string;
  occurredAt: Date;
}

export type EventsDomainEvent =
  | EventCreatedEvent
  | EventUpdatedEvent
  | EventCancelledEvent
  | AttendanceRecordedEvent
  | VolunteerAssignedEvent
  | VolunteerDeclinedEvent;
