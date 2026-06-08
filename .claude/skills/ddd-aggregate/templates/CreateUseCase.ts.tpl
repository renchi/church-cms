import { {{Aggregate}} } from '../domain/{{Aggregate}}.js'
import type { {{Aggregate}}Repository } from '../domain/{{Aggregate}}Repository.js'

export interface Create{{Aggregate}}Input {
  // TODO: input fields (use ids to reference other contexts, e.g. memberId)
}

export class Create{{Aggregate}}UseCase {
  constructor(private readonly repo: {{Aggregate}}Repository) {}

  async execute(input: Create{{Aggregate}}Input): Promise<{ id: string }> {
    // TODO: pre-create checks (e.g. uniqueness) throwing ConflictError if needed.
    const { {{aggregate}} } = {{Aggregate}}.create(input)
    await this.repo.save({{aggregate}})
    return { id: {{aggregate}}.id }
  }
}
