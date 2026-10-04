#!/usr/bin/env node
'use strict'
// The `parity` command: talks to the Parity app's local bridge so a terminal, a script or any
// agent that can run shell commands can use the same QA tools. No dependencies.
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')

const HELP = `parity: QA tools for the page open in Parity

Usage: parity <command> [options]

  status                                   is Parity's bridge on, and what is open
  context                                  project, page, stored designs, tracker format
  designs set <image…> [--breakpoint bp]   store Figma exports (png, jpg, webp) as designs
  capture <bp> [--run <id>] [--refresh]    capture the live page; prints a runId and sections
  overview <run> <bp> [--part <n>]         the design/live overview picture
  section <run> <bp> <S#> [--design <top>:<bottom>] [--part <n>] [--crop <x>:<width>]
                                           design and live crops plus computed values
  draft <run> <bp> <rows.json>             save draft rows for a breakpoint
  finalize <run> <rows.json> [--no-upload] hand the rows over; waits for approval in Parity
  prompt                                   print the QA instructions agents follow
  tools                                    list the tools and their inputs
  call <tool> [json]                       call any tool with a JSON argument object

  bp is desktop, tablet or mobile. Pictures are written to files; their paths are printed.

Options: --json (print the raw response)   --help
Environment: PARITY_DATA_DIR overrides where the port and key are read from.
Exit codes: 0 ok, 1 the tool reported an error, 2 bad usage, 3 Parity's bridge is not reachable.
`

function dataDir() {
  if (process.env.PARITY_DATA_DIR) return process.env.PARITY_DATA_DIR
  const home = os.homedir()
  const base = process.platform === 'win32' ? (process.env.APPDATA || path.join(home, 'AppData', 'Roaming'))
    : process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support')
    : (process.env.XDG_CONFIG_HOME || path.join(home, '.config'))
  return path.join(base, 'Parity', 'qa-agent')
}

class Usage extends Error {}
class Unreachable extends Error {}

function connection() {
  const dir = dataDir()
  let port = 29849
  try { port = Number(JSON.parse(fs.readFileSync(path.join(dir, 'bridge.json'), 'utf8')).port) || port } catch { /* bridge not running, or an older Parity */ }
  let key = ''
  try { key = fs.readFileSync(path.join(dir, 'token'), 'utf8').trim() } catch { /* handled below */ }
  if (!key) throw new Unreachable('Parity has not created its key yet. Open Parity and turn on Settings → AI Agents → Local bridge.')
  return { port, key }
}

function request(method, route, body) {
  const { port, key } = connection()
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const req = http.request({ host: '127.0.0.1', port, method, path: route, headers: { Authorization: `Bearer ${key}`, ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) } }, (res) => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        let parsed
        try { parsed = JSON.parse(data) } catch { parsed = { error: data.slice(0, 200) } }
        if (res.statusCode === 401) return reject(new Unreachable('Parity rejected the key. It may have just been reset; the key is read from Parity\'s data folder on every run, so try the command again.'))
        resolve({ status: res.statusCode || 0, body: parsed })
      })
    })
    req.on('error', (error) => {
      reject(error.code === 'ECONNREFUSED' ? new Unreachable(`Parity's bridge is not running on port ${port}. Open Parity and turn on Settings → AI Agents → Local bridge.`) : error)
    })
    req.end(payload)
  })
}

function parseArgs(argv) {
  const positional = []
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') { positional.push(...argv.slice(i + 1)); break }
    if (arg.startsWith('--')) {
      const name = arg.slice(2)
      if (['json', 'refresh', 'no-upload', 'help'].includes(name)) flags[name] = true
      else {
        const value = argv[++i]
        if (value === undefined) throw new Usage(`--${name} needs a value.`)
        flags[name] = value
      }
    } else positional.push(arg)
  }
  return { positional, flags }
}

const BREAKPOINTS = ['desktop', 'tablet', 'mobile']
function breakpoint(value) {
  if (!BREAKPOINTS.includes(value)) throw new Usage(`The breakpoint must be desktop, tablet or mobile (got "${value || ''}").`)
  return value
}
function pair(value, label) {
  const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(value || '')
  if (!match) throw new Usage(`${label} must look like 120:900.`)
  return [Number(match[1]), Number(match[2])]
}
function readJsonFile(file) {
  let text
  try { text = fs.readFileSync(file, 'utf8') } catch { throw new Usage(`Cannot read ${file}.`) }
  try { return JSON.parse(text) } catch { throw new Usage(`${file} is not valid JSON.`) }
}
function rowsOf(value) {
  const rows = Array.isArray(value) ? value : value && Array.isArray(value.rows) ? value.rows : null
  if (!rows) throw new Usage('The rows file must be a JSON array of { "cells": {…}, "evidence": {…} } or an object with a "rows" array.')
  return rows
}

async function callTool(name, args, flags) {
  const { status, body } = await request('POST', `/api/tools/${name}`, { args })
  if (status !== 200) throw new Error(body.error || `Parity answered ${status}.`)
  if (flags.json) { console.log(JSON.stringify(body, null, 2)); return body.isError ? 1 : 0 }
  console.log(body.text)
  for (const image of body.images || []) console.log(`Image: ${image.caption}${image.file ? ` → ${image.file}` : ''}`)
  return body.isError ? 1 : 0
}

async function main(argv) {
  const { positional, flags } = parseArgs(argv)
  const [command, ...rest] = positional
  if (!command || flags.help || command === 'help') { console.log(HELP); return command || flags.help ? 0 : 2 }

  switch (command) {
    case 'status': {
      const { status, body } = await request('GET', '/api/status')
      if (status !== 200) throw new Error(body.error || `Parity answered ${status}.`)
      if (flags.json) console.log(JSON.stringify(body, null, 2))
      else console.log(body.projectOpen ? `Parity's bridge is on. Open: ${body.project} · ${body.page}` : 'Parity\'s bridge is on, but no project is open in Parity.')
      return 0
    }
    case 'tools': {
      const { body } = await request('GET', '/api/tools')
      if (flags.json) console.log(JSON.stringify(body, null, 2))
      else for (const tool of body.tools) console.log(`${tool.name}${tool.readOnly ? '' : ' (changes something)'}\n  ${tool.description}`)
      return 0
    }
    case 'prompt': {
      const { body } = await request('GET', '/api/prompt')
      console.log(flags.json ? JSON.stringify(body, null, 2) : body.prompt)
      return 0
    }
    case 'context': return callTool('get_context', {}, flags)
    case 'designs': {
      if (rest[0] !== 'set' || rest.length < 2) throw new Usage('Usage: parity designs set <image…> [--breakpoint desktop|tablet|mobile]')
      let code = 0
      for (const file of rest.slice(1)) {
        const args = { path: path.resolve(file) }
        if (flags.breakpoint) args.breakpoint = breakpoint(flags.breakpoint)
        code = Math.max(code, await callTool('set_design', args, flags))
      }
      return code
    }
    case 'capture': {
      const args = { breakpoint: breakpoint(rest[0]) }
      if (flags.run) args.runId = flags.run
      if (flags.refresh) args.refresh = true
      return callTool('capture_live', args, flags)
    }
    case 'overview': {
      if (rest.length < 2) throw new Usage('Usage: parity overview <run> <bp> [--part <n>]')
      const args = { runId: rest[0], breakpoint: breakpoint(rest[1]) }
      if (flags.part) args.part = Number(flags.part)
      return callTool('get_overview', args, flags)
    }
    case 'section': {
      if (rest.length < 3) throw new Usage('Usage: parity section <run> <bp> <S#> [--design <top>:<bottom>] [--part <n>] [--crop <x>:<width>]')
      const args = { runId: rest[0], breakpoint: breakpoint(rest[1]), section: rest[2] }
      if (flags.design) { const [top, bottom] = pair(flags.design, '--design'); args.designTop = top; args.designBottom = bottom }
      if (flags.part) args.part = Number(flags.part)
      if (flags.crop) { const [x, width] = pair(flags.crop, '--crop'); args.cropX = x; args.cropWidth = width }
      return callTool('get_section', args, flags)
    }
    case 'draft': {
      if (rest.length < 3) throw new Usage('Usage: parity draft <run> <bp> <rows.json>')
      return callTool('save_draft', { runId: rest[0], breakpoint: breakpoint(rest[1]), rows: rowsOf(readJsonFile(rest[2])) }, flags)
    }
    case 'finalize': {
      if (rest.length < 2) throw new Usage('Usage: parity finalize <run> <rows.json> [--no-upload]')
      console.error('Waiting for approval in Parity…')
      return callTool('finalize_rows', { runId: rest[0], rows: rowsOf(readJsonFile(rest[1])), ...(flags['no-upload'] ? { uploadEvidence: false } : {}) }, flags)
    }
    case 'call': {
      if (!rest[0]) throw new Usage('Usage: parity call <tool> [json]')
      let args = {}
      if (rest[1]) { try { args = JSON.parse(rest[1]) } catch { throw new Usage('The argument must be valid JSON.') } }
      return callTool(rest[0], args, flags)
    }
    default:
      throw new Usage(`Unknown command "${command}". Run "parity --help".`)
  }
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code },
  (error) => {
    if (error instanceof Usage) { console.error(error.message); process.exitCode = 2 }
    else if (error instanceof Unreachable) { console.error(error.message); process.exitCode = 3 }
    else { console.error(error && error.message ? error.message : String(error)); process.exitCode = 1 }
  },
)
