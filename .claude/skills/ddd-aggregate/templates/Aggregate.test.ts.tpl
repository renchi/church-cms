import { describe, it, expect } from 'vitest'
import { {{Aggregate}} } from './{{Aggregate}}.js'
import { DomainError } from './errors.js'

describe('{{Aggregate}}', () => {
  it('creates with valid input and emits {{Aggregate}}Created', () => {
    const { {{aggregate}}, event } = {{Aggregate}}.create({
      // TODO: valid params
    })

    expect({{aggregate}}.id).toBeDefined()
    expect(event.type).toBe('{{Aggregate}}Created')
    expect(event.{{aggregate}}Id).toBe({{aggregate}}.id)
  })

  it('rejects invalid input with a DomainError', () => {
    expect(() =>
      {{Aggregate}}.create({
        // TODO: invariant-violating params
      }),
    ).toThrow(DomainError)
  })

  it('round-trips through snapshot / reconstitute', () => {
    const { {{aggregate}} } = {{Aggregate}}.create({
      // TODO: valid params
    })
    const restored = {{Aggregate}}.reconstitute({{aggregate}}.toSnapshot())
    expect(restored.toSnapshot()).toEqual({{aggregate}}.toSnapshot())
  })
})
