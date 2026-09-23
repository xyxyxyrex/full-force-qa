import { describe, expect, it } from 'vitest'
import { normalizeWorkspaceUrl, sameWorkspacePage } from './workspaceUrl'

describe('manual workspace URLs', () => {
  it('accepts website addresses and rejects unsupported schemes', () => {
    expect(normalizeWorkspaceUrl(' example.com/about ')).toBe('https://example.com/about')
    expect(normalizeWorkspaceUrl('localhost:3000/about')).toBe('http://localhost:3000/about')
    expect(normalizeWorkspaceUrl('javascript:alert(1)')).toBeNull()
    expect(normalizeWorkspaceUrl('')).toBeNull()
  })

  it('ignores fragments and trailing slashes but keeps distinct pages and queries', () => {
    expect(sameWorkspacePage('https://example.com/about/', 'https://example.com/about#team')).toBe(true)
    expect(sameWorkspacePage('https://example.com/about', 'https://example.com/contact')).toBe(false)
    expect(sameWorkspacePage('https://example.com/about?a=1', 'https://example.com/about?a=2')).toBe(false)
  })
})
