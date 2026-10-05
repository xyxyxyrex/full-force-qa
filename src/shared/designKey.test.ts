import { describe, expect, it } from 'vitest'
import { designKeyOf, pageIdOf, projectOfDesignKey } from './designKey'

describe('pageIdOf', () => {
  it('identifies a page by path and query only', () => {
    expect(pageIdOf('https://svenson.test/alopecia-page/')).toBe('/alopecia-page')
    expect(pageIdOf('https://svenson.test/alopecia-page')).toBe('/alopecia-page')
    expect(pageIdOf('https://staging.svenson.test/alopecia-page/#faq')).toBe('/alopecia-page')
    expect(pageIdOf('https://svenson.test/?p=42')).toBe('/?p=42')
    expect(pageIdOf('https://svenson.test')).toBe('/')
  })
  it('rejects things that are not web pages', () => {
    expect(pageIdOf('not a url')).toBeNull()
    expect(pageIdOf('file:///etc/hosts')).toBeNull()
  })
})

describe('designKeyOf', () => {
  it('gives each page of a project its own key', () => {
    const a = designKeyOf('proj-1', 'https://svenson.test/alopecia-page/')
    const b = designKeyOf('proj-1', 'https://svenson.test/contact/')
    expect(a).toBe('proj-1#/alopecia-page')
    expect(a).not.toBe(b)
    expect(designKeyOf('proj-2', 'https://svenson.test/contact/')).not.toBe(b)
  })
  it('treats a trailing slash or fragment as the same page', () => {
    expect(designKeyOf('p', 'https://x.test/a/')).toBe(designKeyOf('p', 'https://x.test/a#top'))
  })
  it('falls back to the project when the page is unknown', () => {
    expect(designKeyOf('proj-1', undefined)).toBe('proj-1')
    expect(designKeyOf('proj-1', 'nonsense')).toBe('proj-1')
  })
  it('finds the project again', () => {
    expect(projectOfDesignKey('proj-1#/alopecia-page')).toBe('proj-1')
    expect(projectOfDesignKey('proj-1')).toBe('proj-1')
  })
})
