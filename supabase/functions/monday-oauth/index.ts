const MONDAY_TOKEN_URL = 'https://auth.monday.com/oauth_ms/oauth/token'
const MONDAY_LEGACY_TOKEN_URL = 'https://auth.monday.com/oauth2/token'
const MONDAY_REVOKE_URL = 'https://auth.monday.com/oauth_ms/oauth/revoke'
const DEFAULT_REDIRECT_URI = 'http://localhost:51847/oauth/callback'

const jsonHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders })
}

function acceptedPublicKeys(): string[] {
  const keys = new Set<string>()
  const legacy = Deno.env.get('SUPABASE_ANON_KEY')?.trim()
  if (legacy) keys.add(legacy)
  try {
    const configured = JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') || '{}')
    for (const entry of Object.values(configured) as any[]) {
      const value = typeof entry === 'string' ? entry : entry?.key || entry?.value
      if (typeof value === 'string' && value.trim()) keys.add(value.trim())
    }
  } catch { /* legacy projects may not expose the new key dictionary */ }
  return [...keys]
}

async function mondayRequest(url: string, payload: Record<string, unknown>): Promise<Response> {
  const clientId = Deno.env.get('MONDAY_CLIENT_ID')?.trim()
  const clientSecret = Deno.env.get('MONDAY_CLIENT_SECRET')?.trim()
  if (!clientId || !clientSecret) return json({ error: 'Monday OAuth is not configured on the server.' }, 503)

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, ...payload }),
  })
  const result = await response.json().catch(() => ({}))
  if (!response.ok) {
    const message = result?.error_description || result?.error || `Monday OAuth returned ${response.status}.`
    return json({ error: message }, response.status)
  }
  return json(result)
}

async function exchangeAuthorizationCode(payload: {
  code: string
  codeVerifier: string
  redirectUri: string
}): Promise<Response> {
  const requestedMode = Deno.env.get('MONDAY_OAUTH_FLOW')?.trim().toLowerCase()
  const mode = requestedMode === 'legacy' || requestedMode === 'new' ? requestedMode : 'auto'
  const newFlowPayload = {
    grant_type: 'authorization_code',
    code: payload.code,
    code_verifier: payload.codeVerifier,
    redirect_uri: payload.redirectUri,
  }

  if (mode !== 'legacy') {
    const response = await mondayRequest(MONDAY_TOKEN_URL, newFlowPayload)
    if (response.ok || mode === 'new') {
      if (!response.ok) return response
      const result = await response.json()
      return json({ ...result, oauth_flow: 'oauth2.1' })
    }

    const error = await response.clone().json().catch(() => ({})) as { error?: string }
    const compatibilityFailure = /authorization grant|invalid_grant|not_found/i.test(String(error.error || ''))
    if (!compatibilityFailure) return response
  }

  // Monday enables OAuth 2.1 per app version. A live version that has not yet
  // been promoted to the new flow issues codes that exist only in the legacy
  // token service. The failed new-flow lookup does not consume that code.
  const legacyResponse = await mondayRequest(MONDAY_LEGACY_TOKEN_URL, {
    code: payload.code,
    redirect_uri: payload.redirectUri,
  })
  if (!legacyResponse.ok) return legacyResponse
  const legacyResult = await legacyResponse.json()
  return json({ ...legacyResult, oauth_flow: 'legacy' })
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: jsonHeaders })
  if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405)
  const suppliedKey = request.headers.get('apikey')?.trim() || ''
  if (!suppliedKey || !acceptedPublicKeys().includes(suppliedKey)) return json({ error: 'Invalid Supabase public key.' }, 401)

  try {
    const body = await request.json()
    const action = String(body?.action || '')
    const clientId = Deno.env.get('MONDAY_CLIENT_ID')?.trim()
    const configuredRedirect = Deno.env.get('MONDAY_REDIRECT_URI')?.trim() || DEFAULT_REDIRECT_URI

    if (action === 'config') {
      if (!clientId) return json({ error: 'MONDAY_CLIENT_ID is not configured.' }, 503)
      return json({ client_id: clientId, redirect_uri: configuredRedirect, oauth_flow: Deno.env.get('MONDAY_OAUTH_FLOW')?.trim() || 'auto' })
    }

    if (action === 'exchange') {
      const code = String(body?.code || '')
      const verifier = String(body?.code_verifier || '')
      const redirectUri = String(body?.redirect_uri || '')
      if (!code || verifier.length < 43 || verifier.length > 128) return json({ error: 'Invalid OAuth code or PKCE verifier.' }, 400)
      if (redirectUri !== configuredRedirect) return json({ error: 'OAuth redirect URI does not match the configured URI.' }, 400)
      return exchangeAuthorizationCode({ code, codeVerifier: verifier, redirectUri })
    }

    if (action === 'refresh') {
      const refreshToken = String(body?.refresh_token || '')
      if (!refreshToken) return json({ error: 'Refresh token is required.' }, 400)
      return mondayRequest(MONDAY_TOKEN_URL, { grant_type: 'refresh_token', refresh_token: refreshToken })
    }

    if (action === 'revoke') {
      const token = String(body?.token || '')
      if (!token) return json({ error: 'Token is required.' }, 400)
      return mondayRequest(MONDAY_REVOKE_URL, { token, token_type_hint: 'refresh_token' })
    }

    return json({ error: 'Unsupported action.' }, 400)
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'OAuth service failed.' }, 500)
  }
})
