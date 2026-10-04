import { mkdtempSync, rmSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRunStore, RUN_ID_PATTERN } from './runStore'
import type { LiveCaptureResult } from './liveCapture'

let root: string
let clock = Date.UTC(2026, 9, 4, 12, 0, 0)
let store: ReturnType<typeof createRunStore>
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'parity-runs-')); clock = Date.UTC(2026, 9, 4, 12, 0, 0); store = createRunStore(root, () => clock) })
afterEach(() => rmSync(root, { recursive: true, force: true }))

const capture = async (): Promise<LiveCaptureResult> => ({
  png: await sharp({ create: { width: 10, height: 10, channels: 3, background: '#fff' } }).png().toBuffer(),
  width: 1440, viewportHeight: 1024, documentHeight: 3000, capturedHeight: 3000, truncated: false, tiles: 3, mode: 'cdp',
  finalUrl: 'https://x.test/', title: 'X', warnings: ['w'], sections: [], nodes: [], page: { lang: 'en', viewportMeta: '', fontsFailed: [], bodyClass: '' },
})

describe('runStore', () => {
  it('creates runs with safe, valid ids', () => {
    const run = store.create({ projectKey: 'p1', projectName: '[Svenson] SEM Landing Page!', pageUrl: 'https://x.test/a/' })
    expect(run.id).toMatch(RUN_ID_PATTERN)
    expect(run.id).toContain('svenson-sem-landing-page')
    expect(store.get(run.id)).toMatchObject({ projectKey: 'p1', pageUrl: 'https://x.test/a/' })
    expect(store.create({ projectKey: 'p1', projectName: '###', pageUrl: 'u' }).id).toMatch(/-run-[0-9a-f]{4}$/)
  })

  it('rejects ids that could escape the runs folder', () => {
    for (const id of ['../x', '..', 'a/b', '20261004-120000-x-zzzz', '']) {
      expect(() => store.saveDraft(id, 'desktop', [])).toThrow(/valid run id/)
      expect(() => store.outputDir(id)).toThrow(/valid run id/)
      expect(store.readLive(id, 'desktop')).toBeNull()
      expect(store.get(id)).toBeNull()
    }
    expect(readdirSync(root)).toEqual([])
  })

  it('saves and reads a capture, with and without a design', async () => {
    const run = store.create({ projectKey: 'p1', projectName: 'Site', pageUrl: 'u' })
    const design = { png: Buffer.from('design'), meta: { breakpoint: 'desktop', pixelWidth: 2880, pixelHeight: 6000, scale: 2, frameWidth: 1440, frameHeight: 3000, detection: 'dimensions', confidence: 'high', sha256: 'a', addedAt: 1 } as const }
    store.saveCapture(run.id, 'desktop', await capture(), design)
    const live = store.readLive(run.id, 'desktop')!
    expect(live.record).toMatchObject({ width: 1440, mode: 'cdp', warnings: ['w'], design: { scale: 2 } })
    expect(live.png.length).toBeGreaterThan(0)
    expect(store.readDesign(run.id, 'desktop')!.toString()).toBe('design')
    store.saveCapture(run.id, 'desktop', await capture(), null)
    expect(store.readDesign(run.id, 'desktop')).toBeNull()
    expect(store.readLive(run.id, 'mobile')).toBeNull()
  })

  it('saves drafts per breakpoint and finds the latest run for a project', async () => {
    const first = store.create({ projectKey: 'p1', projectName: 'A', pageUrl: 'u' })
    clock += 1000
    const second = store.create({ projectKey: 'p1', projectName: 'B', pageUrl: 'u' })
    store.create({ projectKey: 'other', projectName: 'C', pageUrl: 'u' })
    expect(store.latest('p1')!.id).toBe(second.id)
    expect(store.latest('missing')).toBeNull()
    store.saveDraft(first.id, 'tablet', [{ Issue: 'x' }])
    expect(store.readDrafts(first.id)).toEqual({ tablet: [{ Issue: 'x' }] })
  })

  it('prunes by age, count and size but never a recently used run', async () => {
    const day = 24 * 60 * 60 * 1000
    const ids: string[] = []
    for (let i = 0; i < 5; i++) { ids.push(store.create({ projectKey: 'p', projectName: `r${i}`, pageUrl: 'u' }).id); clock += 60_000 }
    clock += 20 * day
    const fresh = store.create({ projectKey: 'p', projectName: 'fresh', pageUrl: 'u' }).id
    expect(store.prune({ maxAgeDays: 14 }).sort()).toEqual([...ids].sort())
    expect(readdirSync(root)).toEqual([fresh])
    // Count limit: oldest go first, but the protected (just used) run stays.
    clock += 2 * 60 * 60 * 1000
    const more = [1, 2, 3].map((i) => { clock += 1000; return store.create({ projectKey: 'p', projectName: `m${i}`, pageUrl: 'u' }).id })
    clock += 2 * 60 * 60 * 1000
    store.touch(more[2])
    const removed = store.prune({ maxRuns: 2, protectMs: 60 * 60 * 1000 })
    expect(removed).toContain(fresh)
    expect(readdirSync(root)).toContain(more[2])
    expect(readdirSync(root).length).toBeLessThanOrEqual(2)
  })
})
