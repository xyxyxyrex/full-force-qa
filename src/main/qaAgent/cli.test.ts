import { execFile } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createBridgeServer } from './bridge/httpServer'
import { ensureToken } from './bridge/token'
import { bands, createFakeContext, type FakeContext } from './testSupport'

const CLI = resolve(__dirname, '../../../resources/cli/parity.cjs')
let root: string
let dataDir: string
let fake: FakeContext
let bridge: ReturnType<typeof createBridgeServer>
let port: number

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'parity-cli-'))
  dataDir = join(root, 'qa-agent')
  const token = ensureToken(join(dataDir, 'token'))
  fake = createFakeContext(root)
  bridge = createBridgeServer({ getContext: () => fake.context, getToken: () => token })
  port = await bridge.start(0)
  writeFileSync(join(dataDir, 'bridge.json'), JSON.stringify({ port }))
})
afterAll(async () => { await bridge.stop(); rmSync(root, { recursive: true, force: true }) })

interface Run { code: number; out: string; err: string }
// Async on purpose: the bridge runs in this process, so a blocking spawn would deadlock.
const parity = (args: string[], env: Record<string, string> = {}) =>
  new Promise<Run>((done) => {
    execFile(process.execPath, [CLI, ...args], { env: { ...process.env, PARITY_DATA_DIR: dataDir, ...env } }, (error, out, err) => {
      done({ code: error ? (error as NodeJS.ErrnoException & { code?: number }).code as unknown as number : 0, out, err })
    })
  })
const runIdIn = (text: string) => /Run (\S+) ·/.exec(text)![1]

describe('parity command', () => {
  it('prints help, and exits 2 when given nothing or something unknown', async () => {
    expect(await parity(['--help'])).toMatchObject({ code: 0, out: expect.stringContaining('Usage: parity') })
    const none = await parity([])
    expect(none.code).toBe(2); expect(none.out).toContain('Usage: parity')
    const unknown = await parity(['frobnicate'])
    expect(unknown.code).toBe(2); expect(unknown.err).toContain('Unknown command')
  })

  it('reports status and the tools', async () => {
    expect((await parity(['status'])).out).toContain('Open: [Svenson] Alopecia · https://svenson.test/alopecia-page/')
    expect(JSON.parse((await parity(['status', '--json'])).out)).toMatchObject({ ok: true, projectOpen: true })
    const tools = (await parity(['tools'])).out
    expect(tools).toContain('capture_live'); expect(tools).toContain('finalize_rows (changes something)')
    expect((await parity(['prompt'])).out).toContain('visual QA reviewer')
  })

  it('stores designs, captures, reads a section and writes drafts', async () => {
    const image = join(root, 'home@2x.png')
    writeFileSync(image, await bands(2880, 6000))
    expect((await parity(['designs', 'set', image, '--breakpoint', 'desktop'])).out).toContain('Stored as the desktop design: 1440px wide frame, export scale 2x')

    const context = JSON.parse((await parity(['context'])).out)
    expect(context.designs.desktop).toMatchObject({ frameWidth: 1440 })

    const capture = await parity(['capture', 'desktop'])
    expect(capture.code).toBe(0)
    const runId = runIdIn(capture.out)
    const overview = /Image: .* → (\S+overview-1\.jpg)/.exec(capture.out)
    expect(overview && existsSync(overview[1])).toBe(true)

    const section = await parity(['section', runId, 'desktop', 'S2', '--design', '900:1900', '--part', '1'])
    expect(section.code).toBe(0)
    expect(section.out).toContain('Section S2 "Basics" · desktop · part 1 of 2')
    expect(section.out).toMatch(/Image: Design, y 900–1424 → /)

    const rows = join(root, 'rows.json')
    writeFileSync(rows, JSON.stringify([{ cells: { Page: 'Home', Issue: 'Heading too small', Severity: 'High' } }]))
    expect((await parity(['draft', runId, 'desktop', rows])).out).toContain('Saved 1 draft row(s)')
    writeFileSync(rows, JSON.stringify({ rows: [{ cells: { Colour: 'red' } }] }))
    const bad = await parity(['draft', runId, 'desktop', rows])
    expect(bad.code).toBe(1); expect(bad.out).toContain('not in the tracker')
  })

  it('hands rows over for approval and reports the outcome', async () => {
    const runId = runIdIn((await parity(['capture', 'mobile'])).out)
    const rows = join(root, 'final.json')
    writeFileSync(rows, JSON.stringify([{ cells: { Page: 'Home', Issue: '- stray dash', Severity: 'Low' } }]))
    fake.setDecision({ approved: false, note: 'Not a real issue' })
    const rejected = await parity(['finalize', runId, rows])
    expect(rejected.code).toBe(0); expect(rejected.out).toContain('did not approve'); expect(rejected.out).toContain('Not a real issue')
    expect(fake.clipboard).toHaveLength(0)
    fake.setDecision({ approved: true })
    const approved = await parity(['finalize', runId, rows, '--no-upload'])
    expect(approved.out).toContain('Copied 1 row(s)')
    expect(fake.clipboard[0].text).toBe("Home\t'- stray dash\t\t\tLow")
  })

  it('validates usage before talking to Parity', async () => {
    expect((await parity(['capture', 'phone'])).code).toBe(2)
    expect((await parity(['section', 'run', 'desktop'])).code).toBe(2)
    expect((await parity(['section', 'run', 'desktop', 'S1', '--design', 'abc'])).code).toBe(2)
    expect((await parity(['draft', 'run', 'desktop', join(root, 'nope.json')])).code).toBe(2)
    expect((await parity(['call', 'get_context', '{not json'])).code).toBe(2)
    expect((await parity(['capture', 'desktop', '--run'])).code).toBe(2)
  })

  it('supports the generic call command and --json', async () => {
    const result = JSON.parse((await parity(['call', 'get_context', '{}', '--json'])).out)
    expect(result.isError).toBe(false)
    const unknown = await parity(['call', 'rm_rf'])
    expect(unknown.code).toBe(1)
  })

  it('exits 3 with advice when the bridge is off or the key is wrong', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'parity-cli-empty-'))
    const noKey = await parity(['status'], { PARITY_DATA_DIR: empty })
    expect(noKey.code).toBe(3); expect(noKey.err).toContain('Settings → AI Agents')
    ensureToken(join(empty, 'token')); writeFileSync(join(empty, 'bridge.json'), JSON.stringify({ port: 1 }))
    const closed = await parity(['status'], { PARITY_DATA_DIR: empty })
    expect(closed.code).toBe(3); expect(closed.err).toContain('not running')
    writeFileSync(join(empty, 'bridge.json'), JSON.stringify({ port }))
    const wrongKey = await parity(['status'], { PARITY_DATA_DIR: empty })
    expect(wrongKey.code).toBe(3); expect(wrongKey.err).toContain('rejected the key')
    rmSync(empty, { recursive: true, force: true })
  })
})
