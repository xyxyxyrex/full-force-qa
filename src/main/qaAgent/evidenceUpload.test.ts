import { createServer, type IncomingMessage, type Server } from 'http'
import type { AddressInfo } from 'net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createEvidenceUploader, evidenceViewerLink, type EvidenceDeps } from './evidenceUpload'

let server: Server
let base: string
let seen: Array<{ url: string; headers: IncomingMessage['headers']; size: number }>
let respond: (index: number) => { status: number; body: unknown }

beforeEach(async () => {
  seen = []
  respond = (index) => ({ status: 201, body: { url: `${base}/functions/v1/qa-evidence/ID${index}AAAAAAAAAAAAAAAAAAA.webp`, expiresAt: '2027-01-01T00:00:00Z' } })
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      seen.push({ url: req.url || '', headers: req.headers, size: Buffer.concat(chunks).length })
      const { status, body } = respond(seen.length)
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterEach(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)) })

const deps = (over: Partial<EvidenceDeps> = {}): EvidenceDeps => ({
  settings: () => ({ evidenceUploads: true, evidenceDays: 90 }), isSignedIn: () => true, accessToken: async () => 'jwt-token', config: () => ({ url: base, key: 'anon-key' }), ...over,
})
const item = (name: string, label = 'Heading too small') => ({ name, data: Buffer.from('WEBPDATA'), contentType: 'image/webp', label })

describe('evidence uploader', () => {
  it('says why it cannot upload', () => {
    expect(createEvidenceUploader(deps({ settings: () => ({ evidenceUploads: false, evidenceDays: 90 }) })).unavailableReason()).toContain('turned off')
    expect(createEvidenceUploader(deps({ config: () => ({ url: '', key: '' }) })).unavailableReason()).toContain('no online service')
    expect(createEvidenceUploader(deps({ isSignedIn: () => false })).unavailableReason()).toContain('Sign in to your Parity account')
    expect(createEvidenceUploader(deps({ config: () => { throw new Error('not defined') } })).unavailableReason()).toContain('no online service')
    expect(createEvidenceUploader(deps()).unavailableReason()).toBeNull()
  })

  it('uploads each image as the signed-in account and returns the links', async () => {
    const results = await createEvidenceUploader(deps({ settings: () => ({ evidenceUploads: true, evidenceDays: 30 }) })).upload([item('a.webp', 'A & B'), item('b.webp')])
    expect(results).toEqual([{ url: `${base}/functions/v1/qa-evidence/ID1AAAAAAAAAAAAAAAAAAA.webp` }, { url: `${base}/functions/v1/qa-evidence/ID2AAAAAAAAAAAAAAAAAAA.webp` }])
    expect(seen[0].url).toBe('/functions/v1/qa-evidence?days=30&label=A%20%26%20B')
    expect(seen[0].headers).toMatchObject({ authorization: 'Bearer jwt-token', apikey: 'anon-key', 'content-type': 'image/webp' })
    expect(seen[0].size).toBe(8)
  })

  it('reports a failure per image and keeps going', async () => {
    respond = (index) => (index === 1 ? { status: 429, body: {} } : index === 2 ? { status: 201, body: { url: 'https://evil.test/x.webp' } } : { status: 201, body: { url: `${base}/functions/v1/qa-evidence/OKOKOKOKOKOKOKOKOKOKOK.webp` } })
    const results = await createEvidenceUploader(deps()).upload([item('1'), item('2'), item('3')])
    expect(results[0]).toEqual({ error: 'Too many uploads this hour. Try again later.' })
    expect(results[1]).toEqual({ error: 'The upload service answered with an unexpected link.' })
    expect(results[2].url).toContain('OKOKOK')
  })

  it('maps sign-in, size and other errors to plain messages', async () => {
    for (const [status, text] of [[401, 'sign-in was not accepted'], [413, 'too large'], [415, 'not accepted'], [500, 'failed (500)']] as const) {
      respond = () => ({ status, body: { error: 'x' } })
      expect((await createEvidenceUploader(deps()).upload([item('1')]))[0].error).toContain(text)
    }
  })

  it('fails every image with one message when the token cannot be fetched or the service is down', async () => {
    const noToken = await createEvidenceUploader(deps({ accessToken: async () => { throw new Error('Your Parity session expired. Sign in again.') } })).upload([item('1'), item('2')])
    expect(noToken).toEqual([{ error: 'Your Parity session expired. Sign in again.' }, { error: 'Your Parity session expired. Sign in again.' }])
    const down = await createEvidenceUploader(deps({ config: () => ({ url: 'http://127.0.0.1:1', key: 'k' }) })).upload([item('1')])
    expect(down[0].error).toBe('Could not reach the upload service.')
  })
})

describe('viewer links', () => {
  it('puts the Parity viewer page in the screenshot column when a viewer site is set up', async () => {
    const results = await createEvidenceUploader(deps({ config: () => ({ url: base, key: 'anon-key', viewer: 'https://parity-gfx.pages.dev' }) })).upload([item('a.webp')])
    expect(results).toEqual([{ url: 'https://parity-gfx.pages.dev/?evidence=ID1AAAAAAAAAAAAAAAAAAA' }])
  })

  it('keeps the picture link without a viewer site', async () => {
    const results = await createEvidenceUploader(deps()).upload([item('a.webp')])
    expect(results[0].url).toBe(`${base}/functions/v1/qa-evidence/ID1AAAAAAAAAAAAAAAAAAA.webp`)
  })

  it('builds the viewer link only from a real evidence link and an https viewer', () => {
    const image = 'https://proj.supabase.co/functions/v1/qa-evidence/AbCdEfGhIjKlMnOpQrStUv.webp'
    expect(evidenceViewerLink(image, 'https://parity-gfx.pages.dev/')).toBe('https://parity-gfx.pages.dev/?evidence=AbCdEfGhIjKlMnOpQrStUv')
    expect(evidenceViewerLink(image, 'https://example.test/viewer/')).toBe('https://example.test/viewer/?evidence=AbCdEfGhIjKlMnOpQrStUv')
    expect(evidenceViewerLink(image, 'http://insecure.test')).toBe(image)
    expect(evidenceViewerLink(image, 'not a url')).toBe(image)
    expect(evidenceViewerLink(image, '')).toBe(image)
    expect(evidenceViewerLink('https://proj.supabase.co/functions/v1/qa-evidence/short.webp', 'https://parity-gfx.pages.dev')).toBe('https://proj.supabase.co/functions/v1/qa-evidence/short.webp')
  })
})
