import { describe, expect, it } from 'vitest'
import nspell from 'nspell'
import dictionary from 'dictionary-en'
import { isAcceptedSpelling } from './spellingHeuristics'

const spelling = nspell(dictionary)

describe('audit spelling classification', () => {
  it('accepts regular plurals when their singular form is in the dictionary', () => {
    expect(spelling.correct('Tubings')).toBe(false)
    expect(isAcceptedSpelling(spelling, 'Tubings')).toBe(true)
  })

  it('still reports unknown product names without hardcoded exceptions', () => {
    expect(isAcceptedSpelling(spelling, 'GalValum')).toBe(false)
    expect(isAcceptedSpelling(spelling, 'Tbuings')).toBe(false)
    expect(isAcceptedSpelling(spelling, 'thes')).toBe(false)
  })
})
