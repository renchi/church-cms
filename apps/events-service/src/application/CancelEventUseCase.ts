import { NotFoundError } from "../domain/errors.js";
import type { ServiceEventRepository } from "../domain/ServiceEventRepository.js";
import type { VolunteerAssignmentRepository } from "../domain/VolunteerAssignmentRepository.js";

// Touches TWO kinds of aggregate: the event, and every volunteer assignment for
// it (ADR-0004: "assignments to a cancelled event are automatically moved to
// declined"). Each aggregate is saved on its own, so this is not one database
// transaction. Two choices keep the rule true anyway:
//
//   1. Save the event FIRST, then decline ("sweep") its assignments. Any
//      assignment created after the sweep read them sees a cancelled event when
//      AssignVolunteerUseCase re-checks it, and declines itself. Between the
//      two use cases, every ordering of a concurrent assign is covered.
//   2. Cancelling is idempotent: cancelling an already-cancelled event skips
//      step 1 and just sweeps again (declining twice is a no-op). So if the
//      sweep fails half-way, calling cancel again finishes the job.
//
// Once stage 9 adds NATS, the sweep can move to a handler of EventCancelled.
export class CancelEventUseCase {
  constructor(
    private readonly events: ServiceEventRepository,
    private readonly volunteers: VolunteerAssignmentRepository
  ) {}

  async execute(id: string, input: { reason: string }): Promise<void> {
    const event = await this.events.findById(id);
    if (!event) throw new NotFoundError("Event not found");

    if (event.status !== "cancelled") {
      // The domain still guards the transition (e.g. completed → cancelled).
      event.cancel(input.reason);
      // Versioned save: if someone edited the event since we loaded it, this
      // throws a ConflictError and nothing below runs.
      await this.events.save(event);
    }

    const assignments = await this.volunteers.findByEventId(event.id);
    for (const assignment of assignments) {
      if (assignment.decline()) await this.volunteers.save(assignment);
    }
  }
}
