import type { UnitOfWork } from "./UnitOfWork.js";

// Input from a MemberArchived message (Members → Events). The consumer
// translates the wire format into this, so the use case doesn't depend on it.
export interface MemberArchivedInput {
  messageId: string;
  memberId: string;
}

export interface DeclineResult {
  outcome: "applied" | "duplicate";
  declined: number;
}

// ADR-0004: when a member is archived, remove them from all future volunteer
// assignments by setting those to "declined". An archived member won't show
// up to serve, and the rota should show the gap so someone else can fill it.
export class DeclineAssignmentsForArchivedMemberUseCase {
  constructor(private readonly uow: UnitOfWork) {}

  async execute(input: MemberArchivedInput, now: Date = new Date()): Promise<DeclineResult> {
    let declined = 0;
    const ran = await this.uow.runOnce(input.messageId, async ({ volunteerAssignments }) => {
      const active = await volunteerAssignments.findActiveForMemberOnFutureEvents(input.memberId, now);
      for (const assignment of active) {
        // decline() returns null if it was already declined; the query only
        // returns pending or confirmed ones, so here it always declines.
        if (assignment.decline(now)) {
          await volunteerAssignments.save(assignment);
          declined++;
        }
      }
    });
    return ran ? { outcome: "applied", declined } : { outcome: "duplicate", declined: 0 };
  }
}
