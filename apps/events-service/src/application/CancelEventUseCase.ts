import { NotFoundError } from "../domain/errors.js";
import type { ServiceEventRepository } from "../domain/ServiceEventRepository.js";
import type { VolunteerAssignmentRepository } from "../domain/VolunteerAssignmentRepository.js";

// Touches TWO kinds of aggregate: the event, and every volunteer assignment for
// it (ADR-0004: "assignments to a cancelled event are automatically moved to
// declined"). Each aggregate is saved on its own, so this is not one database
// transaction. The order makes a retry safe instead:
//   1. decline the assignments (declining twice is a no-op),
//   2. save the event LAST.
// If anything fails before step 2, the event is still "scheduled", so calling
// cancel again redoes all of it. Once stage 9 adds NATS, the decline step can
// move to a handler of the EventCancelled event.
export class CancelEventUseCase {
  constructor(
    private readonly events: ServiceEventRepository,
    private readonly volunteers: VolunteerAssignmentRepository
  ) {}

  async execute(id: string, input: { reason: string }): Promise<void> {
    const event = await this.events.findById(id);
    if (!event) throw new NotFoundError("Event not found");
    // Validates the transition before anything is written.
    event.cancel(input.reason);

    const assignments = await this.volunteers.findByEventId(event.id);
    for (const assignment of assignments) {
      if (assignment.decline()) await this.volunteers.save(assignment);
    }

    await this.events.save(event);
  }
}
