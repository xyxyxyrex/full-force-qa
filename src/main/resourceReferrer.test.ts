import { describe, expect, it } from 'vitest'
import { capturedResourceCandidates, safeResourceReferer } from './resourceReferrer'

describe('captured resource requests', () => {
  it('does not send an HTTPS page URL to an HTTP asset or link', () => {
    expect(safeResourceReferer('http://example.com/image.png', 'https://example.com/page?token=private')).toBeUndefined()
  })

  it('keeps a full same-origin referrer and limits cross-origin referrers to the origin', () => {
    expect(safeResourceReferer('https://example.com/image.png', 'https://example.com/page')).toBe('https://example.com/page')
    expect(safeResourceReferer('https://example.com/image.png', 'https://example.com/page#section')).toBe('https://example.com/page')
    expect(safeResourceReferer('https://cdn.example.com/image.png', 'https://example.com/page?token=private')).toBe('https://example.com/')
  })

  it('tries a secure version of an old same-host HTTP asset before its original URL', () => {
    expect(capturedResourceCandidates('http://example.com/logo.png?a=1', 'https://example.com/page'))
      .toEqual(['https://example.com/logo.png?a=1', 'http://example.com/logo.png?a=1'])
    expect(capturedResourceCandidates('http://other.com/logo.png', 'https://example.com/page'))
      .toEqual(['http://other.com/logo.png'])
    expect(capturedResourceCandidates('http://example.com:8080/logo.png', 'https://example.com/page'))
      .toEqual(['http://example.com:8080/logo.png'])
  })
})
