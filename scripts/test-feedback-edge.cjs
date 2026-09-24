const assert = require('node:assert/strict')
const path = require('node:path')
const { build } = require('esbuild')

async function main() {
  const reports = []
  let verified = true
  globalThis.__feedbackCreateClient = () => ({
    auth: { getUser: async () => verified
      ? { data: { user: { id: '00000000-0000-4000-8000-000000000111', email: 'verified@example.test', email_confirmed_at: new Date().toISOString() } }, error: null }
      : { data: { user: null }, error: new Error('Unauthorized') } },
    from(table) {
      assert.equal(table, 'parity_feedback')
      return {
        select(_columns, options) {
          assert.equal(options?.head, true)
          return { eq: () => ({ gte: async () => ({ count: reports.length, error: null }) }) }
        },
        insert(record) {
          return { select: () => ({ single: async () => {
            reports.push(record)
            return { data: { id: '00000000-0000-4000-8000-000000000321' }, error: null }
          } }) }
        }
      }
    }
  })
  globalThis.Deno = {
    env: { get: () => 'test-value' },
    serve: handler => { globalThis.__feedbackHandler = handler }
  }
  const result = await build({
    entryPoints: [path.join(__dirname, '../supabase/functions/parity-account-v2/index.ts')],
    bundle: true, platform: 'node', format: 'cjs', write: false,
    plugins: [{ name: 'supabase-test-double', setup(builder) {
      builder.onResolve({ filter: /^https:\/\/esm\.sh\// }, () => ({ path: 'supabase', namespace: 'test' }))
      builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'export const createClient = globalThis.__feedbackCreateClient', loader: 'js' }))
    } }]
  })
  const compiled = { exports: {} }
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, compiled, compiled.exports)
  const send = async (feedback, token = 'valid') => {
    const response = await globalThis.__feedbackHandler(new Request('http://localhost', {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'submit_feedback', feedback })
    }))
    return { status: response.status, body: await response.json() }
  }
  const report = { kind: 'bug', title: 'Audit preview fails', details: 'The image preview does not open.', area: 'audit', appVersion: '1.4.6', platform: 'win32' }
  assert.deepEqual(await send({ ...report, auth_user_id: 'spoofed', contact_email: 'spoofed@example.test' }),
    { status: 200, body: { id: '00000000-0000-4000-8000-000000000321' } })
  assert.equal(reports[0].auth_user_id, '00000000-0000-4000-8000-000000000111')
  assert.equal(reports[0].contact_email, 'verified@example.test')
  assert.equal('spoofed' in reports[0], false)
  assert.equal((await send({ ...report, title: 'No' })).status, 400)
  verified = false
  assert.equal((await send(report, 'invalid')).status, 401)
  verified = true
  for (let i = 0; i < 4; i++) assert.equal((await send(report)).status, 200)
  assert.equal((await send(report)).status, 429)
  assert.equal(reports.length, 5)
  console.log('PASS: verified identity, server-owned reporter fields, validation, and per-user submission limit.')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
