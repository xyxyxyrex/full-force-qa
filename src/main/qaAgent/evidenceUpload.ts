import type { EvidenceUploader } from './tools'

// Uploads evidence images to Parity's private evidence store (the qa-evidence edge function)
// as the signed-in account and returns their links.

export interface EvidenceDeps {
  settings(): { evidenceUploads: boolean; evidenceDays: number }
  isSignedIn(): boolean
  accessToken(): Promise<string>
  /** The project's public address and key (the same ones the account features use). */
  config(): { url: string; key: string }
}

const UPLOAD_TIMEOUT_MS = 60_000

function describeFailure(status: number): string {
  if (status === 401) return 'Your Parity sign-in was not accepted. Sign in again in Settings → Account.'
  if (status === 413) return 'The image is too large.'
  if (status === 415 || status === 400) return 'The image was not accepted.'
  if (status === 429) return 'Too many uploads this hour. Try again later.'
  return `The upload failed (${status}).`
}

// A status check must never throw just because the online service is not configured.
function safeConfig(deps: EvidenceDeps): { url: string; key: string } {
  try { return deps.config() } catch { return { url: '', key: '' } }
}

export function createEvidenceUploader(deps: EvidenceDeps): EvidenceUploader {
  return {
    unavailableReason() {
      if (!deps.settings().evidenceUploads) return 'Evidence uploads are turned off in Settings → AI Agents.'
      const { url, key } = safeConfig(deps)
      if (!url || !key) return 'This build of Parity has no online service configured, so evidence cannot be uploaded.'
      if (!deps.isSignedIn()) return 'Sign in to your Parity account (Settings → Account) to upload evidence.'
      return null
    },

    async upload(items) {
      const { url, key } = safeConfig(deps)
      const base = url.replace(/\/+$/, '')
      const days = deps.settings().evidenceDays
      let token: string
      try { token = await deps.accessToken() } catch (error: any) { return items.map(() => ({ error: error?.message || 'Not signed in.' })) }

      const results: Array<{ url?: string; error?: string }> = []
      for (const item of items) {
        try {
          const response = await fetch(`${base}/functions/v1/qa-evidence?days=${days}&label=${encodeURIComponent(item.label.slice(0, 200))}`, {
            method: 'POST',
            headers: { apikey: key, Authorization: `Bearer ${token}`, 'Content-Type': item.contentType },
            body: new Uint8Array(item.data),
            signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
          })
          if (response.status !== 201) { results.push({ error: describeFailure(response.status) }); continue }
          const body = (await response.json()) as { url?: unknown }
          // Only a link into our own store is accepted, whatever the response says.
          if (typeof body.url === 'string' && body.url.startsWith(`${base}/functions/v1/qa-evidence/`)) results.push({ url: body.url })
          else results.push({ error: 'The upload service answered with an unexpected link.' })
        } catch (error: any) {
          results.push({ error: error?.name === 'TimeoutError' ? 'The upload timed out.' : 'Could not reach the upload service.' })
        }
      }
      return results
    },
  }
}
