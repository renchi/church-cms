// Domain events: facts about something that already happened in this context,
// named in the past tense. Payloads follow ADR-0004.
//
// For now the aggregates only RETURN these; nothing publishes them yet. Wiring
// them onto NATS is stage 9 (CMS-22). That is also when the ones other contexts
// consume (AttendanceRecorded → Members) move to the shared @cms/events package,
// which becomes the published contract between the two services.
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
