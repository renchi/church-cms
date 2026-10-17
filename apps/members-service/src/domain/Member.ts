import { randomUUID } from "crypto";
import { DomainError } from "./errors.js";
import type { MemberArchivedEvent, MemberRegisteredEvent, MemberUpdatedEvent } from "./events.js";

export type MemberStatus = "active" | "archived";

export interface MemberSnapshot {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  status: MemberStatus;
  // A denormalised summary of attendance, which the Events context owns. We
  // never ask Events for it: we keep our own copy, updated from the
  // AttendanceRecorded events it publishes (context map; ADR-0010). It may lag
  // a moment behind Events. That's eventual consistency.
  attendanceCount: number;
  lastAttendedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  // Optimistic locking. The version that was loaded; 0 means "new, never saved".
  // The repository only writes if the stored version still matches, so two
  // writers that loaded the same member (an HTTP archive and the attendance
  // consumer, or two consumer Pods) can't silently overwrite each other.
  version: number;
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// A blank phone ("" or spaces, as an empty form field sends it) means "no phone".
// The rule lives here, so every client of the API gets it, not just the web form.
function normalizePhone(phone: string | null | undefined): string | null {
  const trimmed = phone?.trim();
  return trimmed ? trimmed : null;
}

export class Member {
  private constructor(private snap: MemberSnapshot) {}

  get id() {
    return this.snap.id;
  }
  get name() {
    return this.snap.name;
  }
  get email() {
    return this.snap.email;
  }
  get phone() {
    return this.snap.phone;
  }
  get status() {
    return this.snap.status;
  }
  get attendanceCount() {
    return this.snap.attendanceCount;
  }
  get lastAttendedAt() {
    return this.snap.lastAttendedAt;
  }
  get version() {
    return this.snap.version;
  }
  get createdAt() {
    return this.snap.createdAt;
  }
  get updatedAt() {
    return this.snap.updatedAt;
  }

  static register(params: { name: string; email: string; phone?: string }): {
    member: Member;
    event: MemberRegisteredEvent;
  } {
    if (!params.name.trim()) throw new DomainError("Name is required");
    if (!isValidEmail(params.email.trim())) throw new DomainError("Invalid email format");

    const now = new Date();
    const member = new Member({
      id: randomUUID(),
      name: params.name.trim(),
      email: params.email.toLowerCase().trim(),
      phone: normalizePhone(params.phone),
      status: "active",
      attendanceCount: 0,
      lastAttendedAt: null,
      createdAt: now,
      updatedAt: now,
      version: 0,
    });

    return {
      member,
      event: { type: "MemberRegistered", memberId: member.id, occurredAt: now },
    };
  }

  update(params: { name?: string; phone?: string | null }): MemberUpdatedEvent {
    if (this.snap.status === "archived") throw new DomainError("Cannot update an archived member");
    if (params.name !== undefined) {
      if (!params.name.trim()) throw new DomainError("Name cannot be empty");
      this.snap.name = params.name.trim();
    }
    if (params.phone !== undefined) {
      this.snap.phone = normalizePhone(params.phone);
    }
    this.snap.updatedAt = new Date();
    return { type: "MemberUpdated", memberId: this.id, occurredAt: this.snap.updatedAt };
  }

  archive(): MemberArchivedEvent {
    if (this.snap.status === "archived") throw new DomainError("Member is already archived");
    this.snap.status = "archived";
    this.snap.updatedAt = new Date();
    return { type: "MemberArchived", memberId: this.id, occurredAt: this.snap.updatedAt };
  }

  // Called when Events reports a check-in. Allowed for archived members too:
  // the check-in really happened, even if the archive overtook its message.
  // Messages can arrive out of order, so the date only ever moves forward.
  // This returns no event: it's a copy of another context's fact, not a new one.
  recordAttendance(checkedInAt: Date): void {
    this.snap.attendanceCount += 1;
    if (!this.snap.lastAttendedAt || checkedInAt > this.snap.lastAttendedAt) {
      this.snap.lastAttendedAt = checkedInAt;
    }
    this.snap.updatedAt = new Date();
  }

  toSnapshot(): MemberSnapshot {
    return { ...this.snap };
  }

  static reconstitute(snapshot: MemberSnapshot): Member {
    return new Member(snapshot);
  }
}
