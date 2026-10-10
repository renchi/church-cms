import { ServiceEvent, type ScheduleEventParams } from "../domain/ServiceEvent.js";
import type { ServiceEventRepository } from "../domain/ServiceEventRepository.js";

export type ScheduleEventInput = ScheduleEventParams;

export class ScheduleEventUseCase {
  constructor(private readonly repo: ServiceEventRepository) {}

  async execute(input: ScheduleEventInput): Promise<{ id: string }> {
    // The returned EventCreated domain event is dropped for now; stage 9
    // (CMS-22) publishes it to NATS from here.
    const { event } = ServiceEvent.schedule(input);
    await this.repo.save(event);
    return { id: event.id };
  }
}
