import { describe, expect, it } from 'vitest'
import { finalizeSections, sectionIdAt, type RawBlock } from './sections'

const block = (top: number, height: number, label = '', extra: Partial<RawBlock> = {}): RawBlock => ({ tag: 'section', selector: 'main > section', top, height, label, ...extra })

describe('finalizeSections', () => {
  it('numbers sections top to bottom and keeps their labels', () => {
    const sections = finalizeSections([block(600, 650, 'What is Alopecia'), block(0, 600, 'Hero'), block(1250, 1100, 'The Basics')], 2400)
    expect(sections.map((s) => [s.id, s.top, s.height, s.label])).toEqual([
      ['S1', 0, 600, 'Hero'],
      ['S2', 600, 650, 'What is Alopecia'],
      ['S3', 1250, 1100, 'The Basics'],
    ])
  })

  it('drops blocks nested inside another and tiny ones', () => {
    const sections = finalizeSections([block(0, 600, 'Hero'), block(40, 200, 'Inner'), block(600, 4, 'Spacer'), block(604, 500, 'Next')], 1200)
    expect(sections.map((s) => s.label)).toEqual(['Hero', 'Next'])
  })

  it('merges a thin strip into the section above it', () => {
    const sections = finalizeSections([block(0, 500, 'A'), block(500, 30, 'Divider'), block(530, 400, 'B')], 1000)
    expect(sections.map((s) => [s.label, s.top, s.height])).toEqual([['A', 0, 530], ['B', 530, 400]])
  })

  it('merges a thin first strip into the section below it', () => {
    const sections = finalizeSections([block(0, 40, 'Top bar'), block(40, 500, 'Hero')], 540)
    expect(sections).toHaveLength(1)
    expect(sections[0]).toMatchObject({ top: 0, height: 540, label: 'Hero' })
  })

  it('clips to the page height, tidies labels and falls back to a tag label', () => {
    const sections = finalizeSections([block(0, 5000, '  Long\n  label '), block(100, 100, '')], 1000)
    expect(sections).toHaveLength(1)
    expect(sections[0]).toMatchObject({ height: 1000, label: 'Long label' })
    expect(finalizeSections([block(0, 300, '')], 300)[0].label).toBe('section section')
  })

  it('ignores invalid input and caps the count', () => {
    expect(finalizeSections([block(Number.NaN, 100)], 500)).toEqual([])
    const many = Array.from({ length: 80 }, (_, i) => block(i * 100, 100, `S${i}`))
    expect(finalizeSections(many, 8000)).toHaveLength(60)
  })
})

describe('sectionIdAt', () => {
  const sections = finalizeSections([block(0, 600, 'Hero'), block(600, 400, 'Body')], 1000)
  it('finds the containing section', () => {
    expect(sectionIdAt(sections, 0)).toBe('S1')
    expect(sectionIdAt(sections, 599)).toBe('S1')
    expect(sectionIdAt(sections, 600)).toBe('S2')
    expect(sectionIdAt(sections, 1000)).toBeNull()
  })
})
