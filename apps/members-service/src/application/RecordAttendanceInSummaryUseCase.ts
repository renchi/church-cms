import type { UnitOfWork } from "./UnitOfWork.js";

// Input from an AttendanceRecorded message (Events → Members). The consumer
// translates the wire format into this, so the use case doesn't depend on it.
export interface AttendanceRecordedInput {
  messageId: string;
  memberId: string;
  checkedInAt: Date;
}

// "member-not-found": Events doesn't check that a memberId exists when it
// records a check-in (a known gap, docs/events-service-ddd.md). Retrying can't
// make the member appear, so the message is still marked processed.
export type AttendanceOutcome = "applied" | "duplicate" | "member-not-found";

export class RecordAttendanceInSummaryUseCase {
  constructor(private readonly uow: UnitOfWork) {}

  async execute(input: AttendanceRecordedInput): Promise<AttendanceOutcome> {
    let outcome: AttendanceOutcome = "applied";
    const ran = await this.uow.runOnce(input.messageId, async (members) => {
      const member = await members.findById(input.memberId);
      if (!member) {
        outcome = "member-not-found";
        return;
      }
      member.recordAttendance(input.checkedInAt);
      await members.save(member);
    });
    return ran ? outcome : "duplicate";
  }
}
