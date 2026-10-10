import { vi } from "vitest";
import type { AttendanceRepository } from "../domain/AttendanceRepository.js";
import { ServiceEvent } from "../domain/ServiceEvent.js";
import type { ServiceEventRepository } from "../domain/ServiceEventRepository.js";
import type { VolunteerAssignmentRepository } from "../domain/VolunteerAssignmentRepository.js";

// Shared helpers for the use-case tests: each repository interface stubbed with
// vi.fn() (the same pattern as makeRepo() in members-service), plus a factory
// for an event that starts in an hour, so check-in is open right now.

export const MEMBER = "22222222-2222-4222-8222-222222222222";
export const ADMIN = "33333333-3333-4333-8333-333333333333";

export function upcomingEvent(): ServiceEvent {
  return ServiceEvent.schedule({
    title: "Sunday Morning Service",
    eventType: "service",
    venue: { name: "Main Sanctuary" },
    scheduledAt: new Date(Date.now() + 60 * 60 * 1000),
    durationMinutes: 90,
    createdById: ADMIN,
  }).event;
}

export function makeEventRepo(overrides?: Partial<ServiceEventRepository>): ServiceEventRepository {
  return {
    findById: vi.fn().mockResolvedValue(null),
    listUpcoming: vi.fn().mockResolvedValue({ events: [], total: 0 }),
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

export function makeAttendanceRepo(
  overrides?: Partial<AttendanceRepository>
): AttendanceRepository {
  return {
    findByEventAndMember: vi.fn().mockResolvedValue(null),
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

export function makeVolunteerRepo(
  overrides?: Partial<VolunteerAssignmentRepository>
): VolunteerAssignmentRepository {
  return {
    findByEventMemberAndRole: vi.fn().mockResolvedValue(null),
    findByEventId: vi.fn().mockResolvedValue([]),
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}
