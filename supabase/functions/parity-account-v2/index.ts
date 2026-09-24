import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.57.4'

const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type' }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers })
function object(value: unknown, limit = 1_500_000): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || new TextEncoder().encode(JSON.stringify(value)).length > limit) throw new Error('Invalid or oversized payload.')
  return value as Record<string, any>
}
function userView(row: any) {
  return { ownerKey: row.owner_key, authUserId: row.auth_user_id, mondayUserId: row.monday_user_id || undefined, name: row.display_name, email: row.email }
}
Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers })
  if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405)
  try {
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } })
  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || ''
  const { data: identity, error: authError } = await admin.auth.getUser(token)
  if (authError || !identity.user?.email_confirmed_at) return json({ error: 'Sign in with a verified email.' }, 401)
  const user = identity.user
    const body = object(await request.json())
    const action = String(body.action || '')
    if (action === 'submit_feedback') {
      const feedback = object(body.feedback, 10_000)
      const kind = feedback.kind
      const area = feedback.area
      const title = typeof feedback.title === 'string' ? feedback.title.trim() : ''
      const details = typeof feedback.details === 'string' ? feedback.details.trim() : ''
      const appVersion = typeof feedback.appVersion === 'string' ? feedback.appVersion.trim() : ''
      const platform = typeof feedback.platform === 'string' ? feedback.platform.trim() : ''
      if (!['bug', 'feature', 'general'].includes(kind) ||
        !['dashboard', 'edit', 'live', 'audit', 'automate', 'notes', 'settings', 'other'].includes(area) ||
        title.length < 4 || title.length > 120 || details.length < 10 || details.length > 4000 ||
        !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][a-z0-9.-]+)?$/i.test(appVersion) ||
        !['win32', 'darwin', 'linux'].includes(platform) || !user.email) return json({ error: 'Complete the feedback form and try again.' }, 400)
      const since = new Date(Date.now() - 60 * 60 * 1000).toISOString()
      const { count, error: countError } = await admin.from('parity_feedback').select('id', { count: 'exact', head: true }).eq('auth_user_id', user.id).gte('created_at', since)
      if (countError) throw countError
      if ((count || 0) >= 5) return json({ error: 'You have sent several reports recently. Please try again in an hour.' }, 429)
      const { data, error } = await admin.from('parity_feedback').insert({
        auth_user_id: user.id, contact_email: user.email, kind, title, details, area,
        app_version: appVersion, platform
      }).select('id').single()
      if (error) throw error
      return json({ id: data.id })
    }
    if (action === 'initialize') {
      if (!['new', 'monday'].includes(body.mode)) return json({ error: 'Choose how to initialize your workspace.' }, 400)
      let mondayId: string | null = null
      if (body.mode === 'monday') {
        if (typeof body.mondayToken !== 'string' || !body.mondayToken) return json({ error: 'Connect Monday to verify the existing workspace.' }, 400)
        const response = await fetch('https://api.monday.com/v2', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: body.mondayToken, 'API-Version': '2026-07' }, body: JSON.stringify({ query: 'query ParityRestore { me { id } }' }), signal: AbortSignal.timeout(15000) })
        const result = await response.json()
        if (!response.ok || result.errors?.length || !result.data?.me?.id) return json({ error: 'Monday could not verify your identity.' }, 401)
        mondayId = String(result.data.me.id)
      }
      const { data, error } = await admin.rpc('initialize_parity_account', { p_auth_user_id: user.id, p_email: user.email, p_name: user.user_metadata?.name || user.email?.split('@')[0] || 'Parity user', p_monday_id: mondayId })
      if (error) return json({ error: error.message }, 409)
      const resolved = Array.isArray(data) ? data[0] : data
      if (!resolved?.owner_key) throw new Error('Workspace ownership could not be resolved.')
      return json({ user: userView(resolved) })
    }
    const { data: account, error: accountError } = await admin.from('parity_accounts').select('*').eq('auth_user_id', user.id).maybeSingle()
    if (accountError) throw accountError
    if (!account) return json({ needsSetup: true, email: user.email })
    const owner = account.owner_key
    if (action === 'status') return json({ user: userView(account) })
    if (action === 'bootstrap') {
      const documents = async (table: string, id: string) => {
        const all: any[] = []
        for (let offset = 0; ; offset += 500) {
          const { data, error } = await admin.from(table).select('data,updated_at').eq('owner_key', owner).order(id).range(offset, offset + 499)
          if (error) throw error
          all.push(...(data || []))
          if (!data || data.length < 500) return { data: all, error: null }
        }
      }
      const results = await Promise.all([
        admin.from('parity_user_state').select('data,updated_at').eq('owner_key', owner).maybeSingle(),
        documents('parity_projects', 'project_id'),
        documents('parity_notes', 'note_id'),
      ])
      for (const result of results) if (result.error) throw result.error
      return json({ user: userView(account), state: results[0].data ? { ...results[0].data.data, updatedAt: results[0].data.updated_at } : null,
        projects: (results[1].data || []).map((row: any) => ({ ...row.data, cloudUpdatedAt: row.updated_at })), notes: (results[2].data || []).map((row: any) => ({ ...row.data, cloudUpdatedAt: row.updated_at })) })
    }
    if (action === 'save_state') {
      const { data, error } = await admin.rpc('merge_parity_user_state', { p_owner_key: owner, p_patch: object(body.data, 512_000) })
      if (error) throw error
      return json({ success: true, updatedAt: data })
    }
    if (action === 'save_project' || action === 'save_note') {
      const isNote = action === 'save_note'; const data = object(isNote ? body.note : body.project)
      if (typeof data.id !== 'string' || !data.id || data.id.length > 200) throw new Error('Invalid document ID.')
      const updatedAt = new Date().toISOString()
      const { error } = await admin.from(isNote ? 'parity_notes' : 'parity_projects').upsert({ owner_key: owner, [isNote ? 'note_id' : 'project_id']: data.id, data, updated_at: updatedAt }, { onConflict: isNote ? 'owner_key,note_id' : 'owner_key,project_id' })
      if (error) throw error
      return json({ success: true, updatedAt })
    }
    if (action === 'delete_project' || action === 'delete_note') {
      const isNote = action === 'delete_note'
      const { error } = await admin.from(isNote ? 'parity_notes' : 'parity_projects').delete().eq('owner_key', owner).eq(isNote ? 'note_id' : 'project_id', isNote ? body.noteId : body.projectId)
      if (error) throw error
      return json({ success: true })
    }
    if (action === 'list_tickets') {
      const all: any[] = []
      for (let offset = 0; ; offset += 500) {
        const { data, error } = await admin.from('parity_tickets').select('data,revision').eq('owner_key', owner).order('ticket_id').range(offset, offset + 499)
        if (error) throw error
        all.push(...(data || []).map(row => ({ ticket: row.data, revision: row.revision })))
        if (!data || data.length < 500) break
      }
      return json({ records: all })
    }
    if (action === 'save_ticket') {
      const ticket = object(body.ticket, 200_000)
      if (typeof ticket.title !== 'string' || typeof ticket.description !== 'string' || typeof ticket.sourceStatus !== 'string' || typeof ticket.sourceGroup !== 'string'
        || typeof ticket.source?.connectionId !== 'string' || typeof ticket.source?.externalId !== 'string'
        || !Array.isArray(ticket.assignees) || !Array.isArray(ticket.resources?.otherLinks)
        || typeof ticket.archived !== 'boolean' || typeof ticket.progress?.active !== 'boolean'
        || !Number.isFinite(ticket.createdAt) || !Number.isFinite(ticket.updatedAt)) throw new Error('Invalid ticket fields.')
      for (const url of [ticket.source.url, ticket.resources.stagingUrl, ticket.resources.adminUrl, ticket.resources.figmaUrl, ticket.resources.googleSheetUrl, ...ticket.resources.otherLinks.map((link: any) => link.url)].filter(Boolean)) {
        if (typeof url !== 'string' || !['https:', 'http:'].includes(new URL(url).protocol)) throw new Error('Invalid resource URL.')
      }
      if (typeof ticket.id !== 'string' || !ticket.id || ticket.id.length > 500 || !ticket.title?.trim() || ticket.title.length > 500 || !['manual', 'opsmosis', 'monday'].includes(ticket.source?.provider) || !ticket.source?.connectionId || !ticket.source?.externalId || !['To review', 'In review', 'Needs fixes', 'Verified'].includes(ticket.progress?.qaStatus) || !Number.isSafeInteger(body.revision) || body.revision < 0) throw new Error('Invalid ticket.')
      const { data, error } = await admin.rpc('save_parity_ticket', { p_owner_key: owner, p_ticket: ticket, p_expected_revision: body.revision })
      if (error) throw error
      return json(data)
    }
    return json({ error: 'Unsupported action.' }, 400)
  } catch (error) { return json({ error: error instanceof Error ? error.message : 'Account request failed.' }, 400) }
})
