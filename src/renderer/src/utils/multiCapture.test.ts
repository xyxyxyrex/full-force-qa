import { describe, expect, it } from 'vitest'
import { deriveMultiCaptureName, findMultiCaptureDuplicate, normalizeMultiCaptureUrl, parseMultiCaptureInput, runMultiCaptureQueue } from './multiCapture'

describe('multi-capture input', () => {
  it('parses comma, whitespace, and spreadsheet separators', () => {
    expect(parseMultiCaptureInput('example1.com,example2.com example3.com\thttps://example4.com\nexample5.com').map(item => item.value)).toEqual([
      'example1.com', 'example2.com', 'example3.com', 'https://example4.com', 'example5.com',
    ])
  })

  it('preserves commas in quoted URLs and query values', () => {
    expect(parseMultiCaptureInput('"https://example.com/a,b", https://two.test/?items=a,b')).toEqual([
      { value: 'https://example.com/a,b' },
      { value: 'https://two.test/?items=a,b' },
    ])
  })

  it('splits obvious joined URLs and flags ambiguous joined URLs', () => {
    expect(parseMultiCaptureInput('https://example.comhttps://example2.com').map(item => item.value)).toEqual([
      'https://example.com', 'https://example2.com',
    ])
    expect(parseMultiCaptureInput('https://example.com/pathhttps://example2.com')[0].error).toMatch(/joined URLs/)
    expect(normalizeMultiCaptureUrl('https://example.com?next=https://example2.com').error).toMatch(/joined URLs/)
  })

  it('normalizes supported addresses and retains URL identity fields', () => {
    expect(normalizeMultiCaptureUrl('example.com/Path?a=1#Top').url).toBe('https://example.com/Path?a=1#Top')
    expect(normalizeMultiCaptureUrl('localhost:3000/a').url).toBe('http://localhost:3000/a')
    expect(normalizeMultiCaptureUrl('file:///tmp/a').url).toBeNull()
    expect(deriveMultiCaptureName('https://example.com/work/sample-page/')).toBe('Sample Page')
  })

  it('finds duplicates only before the row or in the destination folder', () => {
    const existing = [
      { url: 'https://example.com/', folderId: 'one' },
      { url: 'https://other.test/', folderId: 'two' },
      { url: 'https://trash.test/', folderId: 'one', inTrash: true },
    ]
    expect(findMultiCaptureDuplicate('example.com', 0, ['example.com'], existing, 'one')).toBe('folder')
    expect(findMultiCaptureDuplicate('other.test', 0, ['other.test'], existing, 'one')).toBeNull()
    expect(findMultiCaptureDuplicate('repeat.test', 1, ['repeat.test', 'repeat.test'], existing, 'one')).toBe('batch')
    expect(findMultiCaptureDuplicate('https://example.com/?a=1', 0, ['https://example.com/?a=1'], existing, 'one')).toBeNull()
  })

  it('limits queue concurrency and stops before starting queued work', async () => {
    let active = 0
    let peak = 0
    let stop = false
    const visited: number[] = []
    const started = await runMultiCaptureQueue([1, 2, 3, 4, 5], async item => {
      active += 1
      peak = Math.max(peak, active)
      visited.push(item)
      if (item === 2) stop = true
      await Promise.resolve()
      active -= 1
    }, () => stop, 3)
    expect(peak).toBeLessThanOrEqual(3)
    expect(started).toBe(2)
    expect(visited).toEqual([1, 2])
  })
})
