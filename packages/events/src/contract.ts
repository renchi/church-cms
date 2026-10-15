// The published contract between the Members and Events contexts (ADR-0010).
//
// This is the ONLY code both services may import (the ESLint
// no-restricted-imports rule forbids importing another service). It describes
// what travels over NATS, not either context's domain model: each service
// keeps its own internal event types in src/domain/events.ts, and a mapper in
// its infrastructure layer translates domain event → wire event. So a service
// can refactor its domain freely as long as the wire format stays the same.

// --- Subjects and streams ------------------------------------------------------
// A NATS subject is a dot-separated name a message is published to. Subscribers
// can use wildcards: `*` matches one token, `>` matches one or more trailing
// tokens. Our naming: cms.<publishing context>.<what happened>.
export const SUBJECTS = {
  memberArchived: "cms.members.archived",
  attendanceRecorded: "cms.events.attendance.recorded",
} as const;

// A JetStream stream stores every message published to its subjects, on disk.
// Each publishing context owns one stream that captures all of its subjects.
export const STREAMS = {
  members: { name: "MEMBERS", subjects: ["cms.members.>"] },
  events: { name: "EVENTS", subjects: ["cms.events.>"] },
} as const;

// --- The envelope ----------------------------------------------------------------
// Every message has the same outer shape. The fields a consumer needs to
// handle ANY message live here; the event-specific facts live in `data`.
//
//   id         — unique per message. Consumers record it to skip duplicates
//                (at-least-once delivery), and the relay sends it as the
//                Nats-Msg-Id header so JetStream drops a re-publish.
//   type       — what happened, past tense.
//   version    — the payload schema version. A breaking change publishes a V2
//                alongside V1 rather than changing V1 under its consumers.
//   occurredAt — when it happened in the publishing context (ISO 8601).
//                JSON has no Date type, so every date travels as a string.
export interface Envelope<TType extends string, TData> {
  id: string;
  type: TType;
  version: 1;
  occurredAt: string;
  data: TData;
}

// Members → Events. ADR-0004: Events declines the member's volunteer
// assignments on future events.
export type MemberArchivedV1 = Envelope<"MemberArchived", { memberId: string }>;

// Events → Members. The context map: Members keeps a denormalised attendance
// summary. `eventId` here is the church event (a ServiceEvent), not the message.
export type AttendanceRecordedV1 = Envelope<
  "AttendanceRecorded",
  { attendanceId: string; eventId: string; memberId: string; checkedInAt: string }
>;

// --- Parsing: the anti-corruption layer at the wire --------------------------------
// TypeScript types vanish at runtime, so a message from another service is
// just `unknown` until we check it. A message that fails these checks will
// never become valid, so the consumer terminates it instead of retrying.
export class InvalidMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidMessageError";
  }
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(obj: Json, key: string, where: string): string {
  const value = obj[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new InvalidMessageError(`${where}.${key} must be a non-empty string`);
  }
  return value;
}

function requireIsoDate(obj: Json, key: string, where: string): string {
  const value = requireString(obj, key, where);
  if (Number.isNaN(Date.parse(value))) {
    throw new InvalidMessageError(`${where}.${key} must be an ISO 8601 date`);
  }
  return value;
}

// Checks the envelope and returns its `data` object for the per-event checks.
function parseEnvelope(raw: unknown, type: string): { envelope: Json; data: Json } {
  if (!isObject(raw)) throw new InvalidMessageError("message must be a JSON object");
  requireString(raw, "id", "message");
  requireIsoDate(raw, "occurredAt", "message");
  if (raw.type !== type) {
    throw new InvalidMessageError(`expected type ${type}, got ${String(raw.type)}`);
  }
  if (raw.version !== 1) {
    throw new InvalidMessageError(`unsupported ${type} version ${String(raw.version)}`);
  }
  if (!isObject(raw.data)) throw new InvalidMessageError("message.data must be an object");
  return { envelope: raw, data: raw.data };
}

export function parseMemberArchived(raw: unknown): MemberArchivedV1 {
  const { envelope, data } = parseEnvelope(raw, "MemberArchived");
  return {
    id: envelope.id as string,
    type: "MemberArchived",
    version: 1,
    occurredAt: envelope.occurredAt as string,
    data: { memberId: requireString(data, "memberId", "data") },
  };
}

export function parseAttendanceRecorded(raw: unknown): AttendanceRecordedV1 {
  const { envelope, data } = parseEnvelope(raw, "AttendanceRecorded");
  return {
    id: envelope.id as string,
    type: "AttendanceRecorded",
    version: 1,
    occurredAt: envelope.occurredAt as string,
    data: {
      attendanceId: requireString(data, "attendanceId", "data"),
      eventId: requireString(data, "eventId", "data"),
      memberId: requireString(data, "memberId", "data"),
      checkedInAt: requireIsoDate(data, "checkedInAt", "data"),
    },
  };
}
