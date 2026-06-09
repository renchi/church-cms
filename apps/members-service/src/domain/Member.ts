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
  createdAt: Date;
  updatedAt: Date;
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
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
      phone: params.phone?.trim() ?? null,
      status: "active",
      createdAt: now,
      updatedAt: now,
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
      this.snap.phone = params.phone?.trim() ?? null;
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

  toSnapshot(): MemberSnapshot {
    return { ...this.snap };
  }

  static reconstitute(snapshot: MemberSnapshot): Member {
    return new Member(snapshot);
  }
}
