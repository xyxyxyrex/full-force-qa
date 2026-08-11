#!/usr/bin/env node
/**
 * Figma capability probe.
 *
 * Answers two questions that decide how much of the Visual Compare rework is
 * available on a view-only seat:
 *
 *   1. Which REST endpoints does this token's seat actually reach?
 *   2. Is the data the rework depends on (auto-layout spacing, per-run text
 *      styling, published style names) actually present in the designers' file?
 *
 * Question 2 matters independently of permissions: if the design was built
 * without auto-layout, the spacing assertions have nothing to assert against
 * no matter what the seat allows.
 *
 * Usage:
 *   FIGMA_TOKEN=figd_... node scripts/figma-capability-probe.mjs "<figma-url>"
 *   node scripts/figma-capability-probe.mjs "<figma-url>" figd_...
 *
 * Read-only. Makes no writes to the Figma file.
 */

const RESET = '\x1b[0m'
const DIM = '\x1b[2m'
const BOLD = '\x1b[1m'
const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const YELLOW = '\x1b[33m'
const CYAN = '\x1b[36m'

const token = process.env.FIGMA_TOKEN || process.argv[3] || ''
const rawUrl = process.argv[2] || ''

if (!token || !rawUrl) {
  console.error('Usage: FIGMA_TOKEN=figd_... node scripts/figma-capability-probe.mjs "<figma-url>"')
  process.exit(2)
}

function parseReference(url) {
  const parsed = new URL(url)
  const match = parsed.pathname.match(/\/(?:design|file|proto|board)\/([^/]+)/i)
  if (!match) throw new Error('Not a Figma design/file/proto URL.')
  const rawNode = parsed.searchParams.get('node-id') || ''
  return { fileKey: match[1], nodeId: rawNode ? rawNode.replace(/-/g, ':') : '' }
}

async function call(path) {
  const started = Date.now()
  try {
    const response = await fetch(`https://api.figma.com/v1${path}`, {
      headers: { 'X-Figma-Token': token }
    })
    const ms = Date.now() - started
    const upgrade = response.headers.get('x-figma-upgrade-link') || ''
    let body = null
    let errText = ''
    try {
      body = await response.json()
      if (!response.ok) errText = body?.err || body?.message || ''
    } catch {
      errText = 'unreadable response body'
    }
    return { ok: response.ok, status: response.status, body, errText, upgrade, ms }
  } catch (cause) {
    return { ok: false, status: 0, body: null, errText: cause?.message || 'network failure', upgrade: '', ms: Date.now() - started }
  }
}

function line(label, result, note = '') {
  const mark = result.ok ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`
  const status = result.status ? String(result.status) : '---'
  console.log(`  ${mark}  ${status.padEnd(4)} ${DIM}${String(result.ms).padStart(5)}ms${RESET}  ${label}`)
  if (!result.ok && result.errText) console.log(`        ${DIM}${result.errText}${RESET}`)
  if (result.upgrade) console.log(`        ${YELLOW}seat/plan gate: ${result.upgrade}${RESET}`)
  if (note) console.log(`        ${DIM}${note}${RESET}`)
}

// Walk a node tree collecting the properties the rework depends on.
function auditTree(root) {
  const stat = {
    nodes: 0, text: 0, frames: 0,
    autoLayout: 0, itemSpacing: 0, padding: 0,
    styledSegments: 0, textCase: 0,
    styleRefs: 0, imageFills: 0, componentInstances: 0,
    cornerRadius: 0, effects: 0
  }
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    stat.nodes++
    if (node.type === 'TEXT') {
      stat.text++
      if (Array.isArray(node.characterStyleOverrides) && node.characterStyleOverrides.some((v) => v)) stat.styledSegments++
      if (node.style?.textCase && node.style.textCase !== 'ORIGINAL') stat.textCase++
    }
    if (node.type === 'FRAME' || node.type === 'COMPONENT' || node.type === 'INSTANCE') stat.frames++
    if (node.layoutMode && node.layoutMode !== 'NONE') stat.autoLayout++
    if (typeof node.itemSpacing === 'number' && node.itemSpacing > 0) stat.itemSpacing++
    if (['paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom'].some((k) => typeof node[k] === 'number' && node[k] > 0)) stat.padding++
    if (node.styles && Object.keys(node.styles).length) stat.styleRefs++
    if (Array.isArray(node.fills) && node.fills.some((f) => f?.type === 'IMAGE')) stat.imageFills++
    if (node.type === 'INSTANCE') stat.componentInstances++
    if (typeof node.cornerRadius === 'number' && node.cornerRadius > 0) stat.cornerRadius++
    if (Array.isArray(node.effects) && node.effects.length) stat.effects++
    for (const child of node.children || []) walk(child)
  }
  walk(root)
  return stat
}

function verdict(count, total, goodAt, label, consequence) {
  const pct = total ? Math.round((count / total) * 100) : 0
  const colour = count >= goodAt ? GREEN : count > 0 ? YELLOW : RED
  const state = count >= goodAt ? 'usable' : count > 0 ? 'sparse' : 'absent'
  console.log(`  ${colour}${state.padEnd(7)}${RESET} ${String(count).padStart(5)} ${DIM}/ ${total}${RESET}  ${label}`)
  if (count < goodAt && consequence) console.log(`          ${DIM}${consequence}${RESET}`)
  return pct
}

async function main() {
  const { fileKey, nodeId } = parseReference(rawUrl)
  console.log(`\n${BOLD}Figma capability probe${RESET}`)
  console.log(`${DIM}file ${fileKey}${nodeId ? `  ·  node ${nodeId}` : ''}${RESET}\n`)

  // ---- 1. Identity -------------------------------------------------------
  console.log(`${BOLD}${CYAN}1. Identity${RESET}`)
  const me = await call('/me')
  line('GET /v1/me', me)
  if (me.ok) console.log(`        ${DIM}${me.body?.email || 'unknown'}  ·  handle ${me.body?.handle || '?'}${RESET}`)
  if (!me.ok) {
    console.log(`\n${RED}Token is not usable at all. Everything below would fail for the same reason.${RESET}\n`)
    process.exit(1)
  }

  // ---- 2. Endpoint reach -------------------------------------------------
  console.log(`\n${BOLD}${CYAN}2. Endpoint reach on this seat${RESET}`)

  const shallow = await call(`/files/${encodeURIComponent(fileKey)}?depth=1`)
  line('GET /files/:key            file content (the whole plan depends on this)', shallow)

  if (!shallow.ok) {
    console.log(`\n${RED}File content is blocked for this seat.${RESET}`)
    console.log(`${DIM}Without this endpoint the spec-comparison approach cannot run at all;`)
    console.log(`the fallback would be rendered-image comparison only. Check the gate link above.${RESET}\n`)
    process.exit(1)
  }

  const deep = await call(`/files/${encodeURIComponent(fileKey)}?depth=4`)
  line('GET /files/:key?depth=4    nested frame discovery', deep)

  // Pick a frame to inspect in detail.
  let targetId = nodeId
  if (!targetId) {
    for (const page of shallow.body?.document?.children || []) {
      const found = (page.children || []).find((n) => ['FRAME', 'COMPONENT', 'SECTION'].includes(n.type))
      if (found) { targetId = found.id; break }
    }
  }

  let nodesResult = null
  if (targetId) {
    nodesResult = await call(`/files/${encodeURIComponent(fileKey)}/nodes?ids=${encodeURIComponent(targetId)}`)
    line(`GET /files/:key/nodes      full node detail for ${targetId}`, nodesResult)
  } else {
    console.log(`  ${YELLOW}SKIP${RESET}  ---          -  no frame found to inspect`)
  }

  const images = targetId
    ? await call(`/images/${encodeURIComponent(fileKey)}?ids=${encodeURIComponent(targetId)}&format=png&scale=2`)
    : null
  if (images) line('GET /images/:key           frame render at scale=2', images)

  const fileStyles = await call(`/files/${encodeURIComponent(fileKey)}/styles`)
  line('GET /files/:key/styles     published style library', fileStyles,
    'Not required — style names also arrive in the file response below.')

  const variables = await call(`/files/${encodeURIComponent(fileKey)}/variables/local`)
  line('GET /files/:key/variables  design variables (Enterprise only)', variables,
    'Expected to fail outside Enterprise. The plan treats this as optional enrichment.')

  const comments = await call(`/files/${encodeURIComponent(fileKey)}/comments`)
  line('GET /files/:key/comments   read comments', comments,
    'Only matters if you later want findings posted back into Figma.')

  // ---- 3. Data actually present in the file ------------------------------
  console.log(`\n${BOLD}${CYAN}3. Is the data the rework needs actually in this file?${RESET}`)

  const topStyles = shallow.body?.styles ? Object.keys(shallow.body.styles).length : 0
  console.log(`  ${topStyles > 0 ? GREEN + 'usable ' : RED + 'absent '}${RESET} ${String(topStyles).padStart(5)}        named styles in the file response`)
  if (topStyles === 0) {
    console.log(`          ${DIM}No published styles. Findings will quote raw values ("40px") rather than${RESET}`)
    console.log(`          ${DIM}token names ("text/heading-2"). Everything still works, tickets are just vaguer.${RESET}`)
  }

  const detailNode = nodesResult?.ok ? nodesResult.body?.nodes?.[targetId]?.document : null
  if (!detailNode) {
    console.log(`\n  ${YELLOW}Could not inspect a frame in detail; skipping the content audit.${RESET}`)
  } else {
    const s = auditTree(detailNode)
    console.log(`  ${DIM}audited "${detailNode.name}" — ${s.nodes} nodes, ${s.text} text layers${RESET}\n`)

    verdict(s.autoLayout, s.frames, Math.max(3, Math.round(s.frames * 0.25)), 'frames using auto-layout',
      'Spacing assertions lose their strongest source. Falls back to measured gaps between siblings.')
    verdict(s.itemSpacing, s.frames, Math.max(2, Math.round(s.frames * 0.15)), 'frames declaring itemSpacing (gap spec)',
      'No explicit gap spec to assert CSS gap against.')
    verdict(s.padding, s.frames, Math.max(2, Math.round(s.frames * 0.15)), 'frames declaring padding',
      'No explicit padding spec; padding errors detectable only by measured position.')
    verdict(s.styleRefs, s.nodes, Math.max(3, Math.round(s.nodes * 0.05)), 'nodes referencing a named style',
      'Findings cannot name the token that was violated.')
    verdict(s.styledSegments, s.text, 1, 'text layers with mixed per-run styling',
      'None found — a single style per text layer is safe to assume here.')
    verdict(s.textCase, s.text, 1, 'text layers using textCase (UPPER/TITLE)',
      'None found — designers likely typed caps literally; check text-transform mismatches manually.')
    verdict(s.componentInstances, s.nodes, 1, 'component instances (stable semantic identity)',
      'Matching will lean entirely on text and geometry.')
    verdict(s.imageFills, s.nodes, 1, 'nodes with image fills')
    verdict(s.cornerRadius, s.nodes, 1, 'nodes with corner radius')
    verdict(s.effects, s.nodes, 1, 'nodes with effects (shadows)')
  }

  // ---- 4. Summary --------------------------------------------------------
  console.log(`\n${BOLD}${CYAN}4. Verdict${RESET}`)
  const core = shallow.ok && (nodesResult?.ok ?? false) && (images?.ok ?? false)
  if (core) {
    console.log(`  ${GREEN}The spec-comparison rework is fully available on this seat.${RESET}`)
    console.log(`  ${DIM}File content, node detail and rendering all work. Viewer access is sufficient.${RESET}`)
  } else {
    console.log(`  ${RED}Core endpoints are gated. See the failures above before starting the rework.${RESET}`)
  }
  if (!variables.ok) console.log(`  ${DIM}Design variables unavailable, as expected — plan already treats these as optional.${RESET}`)
  if (!deep.ok) console.log(`  ${YELLOW}Deep traversal failed; frame discovery must stay shallow.${RESET}`)
  console.log('')
}

main().catch((error) => {
  console.error(`\n${RED}Probe failed: ${error.message}${RESET}\n`)
  process.exit(1)
})
