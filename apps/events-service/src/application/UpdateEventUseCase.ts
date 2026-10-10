import { NotFoundError } from "../domain/errors.js";
import type { UpdateEventParams } from "../domain/ServiceEvent.js";
import type { ServiceEventRepository } from "../domain/ServiceEventRepository.js";

export type UpdateEventInput = UpdateEventParams;

export class UpdateEventUseCase {
  constructor(private readonly repo: ServiceEventRepository) {}

  async execute(id: string, input: UpdateEventInput): Promise<void> {
    const event = await this.repo.findById(id);
    if (!event) throw new NotFoundError("Event not found");
    event.update(input);
    await this.repo.save(event);
  }
}
