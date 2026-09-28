import { describe, expect, it } from 'vitest'
import { extractFigmaUrl } from './figmaClipboard'

describe('Figma clipboard links', () => {
  it('finds a design link in surrounding clipboard text', () => {
    expect(extractFigmaUrl('See https://www.figma.com/design/abc/Example?node-id=1-2 for this screen.'))
      .toBe('https://www.figma.com/design/abc/Example?node-id=1-2')
  })
  it('accepts a Figma embed link', () => {
    expect(extractFigmaUrl('https://www.figma.com/embed?url=https%3A%2F%2Fwww.figma.com%2Ffile%2Fabc%2FExample'))
      .toBe('https://www.figma.com/file/abc/Example')
  })
  it('ignores arbitrary and lookalike URLs', () => {
    expect(extractFigmaUrl('https://figma.com.evil.test/design/abc')).toBeNull()
    expect(extractFigmaUrl('https://example.com/image.png')).toBeNull()
    expect(extractFigmaUrl('some notes')).toBeNull()
  })
})
