import { describe, expect, it } from 'vitest'
import { colorToHex, formatNodeLine, formatSectionNodes } from './formatNodes'
import type { LiveNode } from './liveCapture'

const base = { fontFamily: '"Playfair Display", serif', fontSize: '48px', fontWeight: '600', lineHeight: '57.6px', letterSpacing: 'normal', color: 'rgb(26, 26, 26)', textAlign: 'center', textTransform: 'none', textDecoration: 'none', display: 'block', position: 'static', opacity: '1', backgroundColor: 'rgba(0, 0, 0, 0)', backgroundImage: 'none', padding: '0', margin: '0 0 24 0', gap: 'normal', border: '0 none rgb(0, 0, 0)', borderRadius: '0px', shadow: 'none', flex: '' }
const node = (over: Partial<LiveNode> & { styles?: Record<string, string> } = {}): LiveNode => ({
  tag: 'h2', text: 'Why choose Svenson?', rect: { x: 120, y: 1846, width: 1200, height: 58 }, path: 'x', sectionId: 'S3',
  ...over, styles: { ...base, ...(over.styles || {}) },
})

describe('colorToHex', () => {
  it('converts rgb and rgba', () => {
    expect(colorToHex('rgb(26, 26, 26)')).toBe('#1A1A1A')
    expect(colorToHex('rgba(255, 0, 128, 0.5)')).toBe('#FF008080')
    expect(colorToHex('rgba(0, 0, 0, 0)')).toBe('transparent')
    expect(colorToHex('rgb(1 2 3 / 50%)')).toBe('#01020380')
    expect(colorToHex('red')).toBe('red')
  })
})

describe('formatNodeLine', () => {
  it('formats a heading the way the plan describes', () => {
    expect(formatNodeLine(node(), 41)).toBe('#41 h2 "Why choose Svenson?" x120 y1846 w1200 h58 | Playfair Display 48/57.6 600 #1A1A1A center | m 0 0 24 0')
  })

  it('shows boxes with paint, spacing and flex, and marks positioned elements', () => {
    const line = formatNodeLine(node({ tag: 'div', text: '', positioned: 'fixed', styles: { backgroundColor: 'rgb(34, 51, 68)', padding: '40', margin: '0', borderRadius: '16px', shadow: 'yes', border: '1 solid rgb(255, 255, 255)', flex: 'row/center/center', gap: '24px 24px' } }), 7)
    expect(line).toBe('#7 div x120 y1846 w1200 h58 (fixed) | bg #223344, border 1 solid #FFFFFF, radius 16, shadow, p 40, gap 24 24, flex row/center/center')
  })

  it('describes images with their natural size and file', () => {
    const line = formatNodeLine(node({ tag: 'img', text: 'Scalp photo', src: 'https://x.test/wp-content/a/scalp.jpg?v=3', natural: '1200x800', objectFit: 'cover', styles: { margin: '0' } }), 3)
    expect(line).toBe('#3 img "Scalp photo" x120 y1846 w1200 h58 | img 1200x800 cover scalp.jpg')
  })

  it('shortens long text and swaps double quotes', () => {
    const line = formatNodeLine(node({ text: 'He said "stop" '.repeat(10) }), 1)
    expect(line).toContain('…')
    expect(line).not.toMatch(/"[^"]*"[^"]*"[^"]*"\s+x/)
  })
})

describe('formatSectionNodes', () => {
  const nodes: LiveNode[] = [
    node({ rect: { x: 0, y: 300, width: 100, height: 20 }, text: 'second' }),
    node({ tag: 'div', text: '', rect: { x: 0, y: 100, width: 100, height: 100 }, styles: { backgroundColor: 'rgb(0, 0, 0)' } }),
    node({ rect: { x: 0, y: 200, width: 100, height: 20 }, text: 'first' }),
    node({ sectionId: 'S9', text: 'other section' }),
  ]

  it('keeps only the section, in reading order', () => {
    const result = formatSectionNodes(nodes, 'S3')
    expect(result.total).toBe(3)
    expect(result.omitted).toBe(0)
    expect(result.lines.map((line) => line.split(' ')[0])).toEqual(['#1', '#2', '#0'])
  })

  it('caps the list, preferring text and images over empty boxes, and reports what was left out', () => {
    const result = formatSectionNodes(nodes, 'S3', 2)
    expect(result.lines).toHaveLength(2)
    expect(result.omitted).toBe(1)
    expect(result.lines.join('\n')).not.toContain('#1 div')
  })

  it('keeps element ids from the full capture when limited to a range', () => {
    const result = formatSectionNodes(nodes, 'S3', 80, { top: 250, bottom: 400 })
    expect(result.lines).toHaveLength(1)
    expect(result.lines[0].startsWith('#0 h2 "second"')).toBe(true)
    expect(result.total).toBe(1)
  })
})
