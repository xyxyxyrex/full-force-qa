/* Isolated PostgreSQL cluster: never connects to the application's database. */
const { spawnSync } = require('node:child_process')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const bin = process.env.PG_BIN || 'C:/Program Files/PostgreSQL/16/bin'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-db-test-'))
const port = 24000 + Math.floor(Math.random() * 10000)
function run(name, args, input) {
  const result = spawnSync(path.join(bin, name), args, { input, encoding: 'utf8', windowsHide: true, timeout: 60000, ...(name === 'pg_ctl' ? { stdio: 'ignore' } : {}) })
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || result.stdout)
  return result.stdout
}
const sql = input => run('psql', ['-X', '-h', '127.0.0.1', '-p', String(port), '-U', 'parity_test', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], input)
let started = false
try {
  run('initdb', ['-D', path.join(dir, 'data'), '-U', 'parity_test', '-A', 'trust', '--no-locale', '-E', 'UTF8'])
  run('pg_ctl', ['-D', path.join(dir, 'data'), '-l', path.join(dir, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port}`, '-w', 'start']); started = true
  sql('create role anon; create role authenticated; create role service_role; create schema auth; create table auth.users(id uuid primary key);')
  sql(fs.readFileSync(path.join(__dirname, '../supabase/migrations/20260811130000_create_parity_account_data.sql'), 'utf8'))
  sql(`insert into parity_accounts(owner_key,monday_user_id,email) values ('monday:7','7','same@example.com');
    insert into parity_notes values ('monday:7','note-1','{"attachments":[{"uri":"parity-note://attachment/original/path.png"}]}',now());
    insert into parity_projects values ('monday:7','monday-42','{"id":"monday-42","folderId":"folder-1"}',now());
    insert into parity_user_state values ('monday:7','{"folders":[{"id":"folder-1"}],"settings":{"theme":"dark"}}',now());`)
  sql(fs.readFileSync(path.join(__dirname, '../supabase/migrations/20260921090000_independent_accounts_and_tickets.sql'), 'utf8'))
  console.log(sql(fs.readFileSync(path.join(__dirname, 'fixtures/account-database.sql'), 'utf8')).trim())
  console.log('PASS: additive migration, dual-identity restoration, repeated linking, ownership conflicts, private table/RPC permissions and ticket revisions.')
} finally {
  if (started) run('pg_ctl', ['-D', path.join(dir, 'data'), '-m', 'fast', '-w', 'stop'])
  console.log('Isolated database artifacts:', dir)
}
