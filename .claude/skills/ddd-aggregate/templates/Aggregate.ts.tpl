import { randomUUID } from 'crypto'
import { DomainError } from './errors.js'
import type { {{Aggregate}}CreatedEvent } from './{{aggregate}}Events.js'

export interface {{Aggregate}}Snapshot {
  id: string
  // TODO: add this aggregate's fields.
  // Reference other contexts by id ONLY (e.g. memberId: string) — never embed
  // another context's aggregate. See docs/adr/context-map.md (ACL rule).
  createdAt: Date
  updatedAt: Date
}

export class {{Aggregate}} {
  private constructor(private snap: {{Aggregate}}Snapshot) {}

  get id() { return this.snap.id }
  get createdAt() { return this.snap.createdAt }
  get updatedAt() { return this.snap.updatedAt }

  static create(params: {
    // TODO: creation parameters
  }): { {{aggregate}}: {{Aggregate}}; event: {{Aggregate}}CreatedEvent } {
    // TODO: validate invariants here — throw new DomainError('...') on violation.

    const now = new Date()
    const {{aggregate}} = new {{Aggregate}}({
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
    })

    return {
      {{aggregate}},
      event: { type: '{{Aggregate}}Created', {{aggregate}}Id: {{aggregate}}.id, occurredAt: now },
    }
  }

  toSnapshot(): {{Aggregate}}Snapshot {
    return { ...this.snap }
  }

  static reconstitute(snapshot: {{Aggregate}}Snapshot): {{Aggregate}} {
    return new {{Aggregate}}(snapshot)
  }
}
