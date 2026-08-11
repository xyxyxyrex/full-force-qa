const { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')

const projectRoot = resolve(__dirname, '..')
const sourceDir = join(projectRoot, 'viewer')
const outputDir = join(projectRoot, 'dist-viewer')

function readLocalEnv() {
  const values = {}
  const envPath = join(projectRoot, '.env')
  if (!existsSync(envPath)) return values
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([^#=]+)=(.*)$/)
    if (!match) continue
    values[match[1].trim()] = match[2].trim().replace(/^(['"])(.*)\1$/, '$2')
  }
  return values
}

const localEnv = readLocalEnv()
const supabaseUrl = process.env.VITE_SUPABASE_URL || localEnv.VITE_SUPABASE_URL || ''
const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY || localEnv.VITE_SUPABASE_ANON_KEY || ''

if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(supabaseUrl) || !supabaseAnonKey) {
  throw new Error('Viewer build requires VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.')
}

rmSync(outputDir, { recursive: true, force: true })
mkdirSync(outputDir, { recursive: true })
cpSync(sourceDir, outputDir, { recursive: true })

const htmlPath = join(outputDir, 'index.html')
const html = readFileSync(htmlPath, 'utf8')
  .replace('__SUPABASE_URL__', JSON.stringify(supabaseUrl))
  .replace('__SUPABASE_ANON_KEY__', JSON.stringify(supabaseAnonKey))

writeFileSync(htmlPath, html)
console.log('Built Cloudflare Pages viewer in dist-viewer.')
