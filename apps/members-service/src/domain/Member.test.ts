import { describe, expect, it } from 'vitest'
import { Member } from './Member.js'
import { DomainError } from './errors.js'

describe('Member.register', () => {
  it('creates an active member with valid inputs', () => {
    const { member } = Member.register({ name: 'Alice', email: 'alice@example.com' })
    expect(member.name).toBe('Alice')
    expect(member.email).toBe('alice@example.com')
    expect(member.status).toBe('active')
    expect(member.phone).toBeNull()
    expect(member.id).toBeTruthy()
  })

  it('trims whitespace and lowercases email', () => {
    const { member } = Member.register({ name: '  Bob  ', email: '  BOB@EXAMPLE.COM  ' })
    expect(member.name).toBe('Bob')
    expect(member.email).toBe('bob@example.com')
  })

  it('stores phone when provided', () => {
    const { member } = Member.register({ name: 'Alice', email: 'alice@example.com', phone: '+1234567890' })
    expect(member.phone).toBe('+1234567890')
  })

  it('emits a MemberRegistered event', () => {
    const { event } = Member.register({ name: 'Alice', email: 'alice@example.com' })
    expect(event.type).toBe('MemberRegistered')
    expect(event.memberId).toBeTruthy()
  })

  it('throws DomainError for empty name', () => {
    expect(() => Member.register({ name: '   ', email: 'x@x.com' })).toThrow(DomainError)
  })

  it('throws DomainError for invalid email', () => {
    expect(() => Member.register({ name: 'Alice', email: 'not-an-email' })).toThrow(DomainError)
  })
})

describe('Member.archive', () => {
  it('sets status to archived', () => {
    const { member } = Member.register({ name: 'Alice', email: 'alice@example.com' })
    member.archive()
    expect(member.status).toBe('archived')
  })

  it('throws DomainError when already archived', () => {
    const { member } = Member.register({ name: 'Alice', email: 'alice@example.com' })
    member.archive()
    expect(() => member.archive()).toThrow(DomainError)
  })
})

describe('Member.update', () => {
  it('updates name', () => {
    const { member } = Member.register({ name: 'Alice', email: 'alice@example.com' })
    member.update({ name: 'Alicia' })
    expect(member.name).toBe('Alicia')
  })

  it('clears phone when null is passed', () => {
    const { member } = Member.register({ name: 'Alice', email: 'alice@example.com', phone: '123' })
    member.update({ phone: null })
    expect(member.phone).toBeNull()
  })

  it('throws DomainError for empty name', () => {
    const { member } = Member.register({ name: 'Alice', email: 'alice@example.com' })
    expect(() => member.update({ name: '  ' })).toThrow(DomainError)
  })

  it('throws DomainError when updating an archived member', () => {
    const { member } = Member.register({ name: 'Alice', email: 'alice@example.com' })
    member.archive()
    expect(() => member.update({ name: 'Alicia' })).toThrow(DomainError)
  })
})

describe('Member.reconstitute', () => {
  it('round-trips through snapshot', () => {
    const { member } = Member.register({ name: 'Alice', email: 'alice@example.com' })
    const restored = Member.reconstitute(member.toSnapshot())
    expect(restored.id).toBe(member.id)
    expect(restored.email).toBe(member.email)
    expect(restored.status).toBe('active')
  })
})
