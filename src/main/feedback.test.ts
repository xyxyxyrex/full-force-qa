import { describe, expect, it } from 'vitest'
import { validateFeedback } from './feedback'

describe('feedback validation', () => {
  it('accepts a bounded report and trims its text', () => {
    expect(validateFeedback({ kind: 'bug', area: 'audit', title: '  Broken preview  ', details: '  Preview shows an error  ' }))
      .toEqual({ kind: 'bug', area: 'audit', title: 'Broken preview', details: 'Preview shows an error' })
  })

  it('rejects missing, oversized, and unsupported submissions', () => {
    expect(() => validateFeedback({ kind: 'bug', area: 'audit', title: 'Hi', details: 'Too short' })).toThrow()
    expect(() => validateFeedback({ kind: 'bug', area: 'audit', title: 'Valid title', details: 'x'.repeat(4001) })).toThrow()
    expect(() => validateFeedback({ kind: 'admin', area: 'audit', title: 'Valid title', details: 'Enough description' })).toThrow()
  })
})
