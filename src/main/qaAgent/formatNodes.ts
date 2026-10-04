import type { LiveNode } from './liveCapture'

// One compact line per element so the agent can read real computed values next to the
// pictures, e.g.
//   #41 h2 "Why choose Svenson?" x120 y1846 w1200 h58 | Playfair Display 48/57.6 600 #1A1A1A center | m 0 0 24 0

const hex = (n: number) => n.toString(16).padStart(2, '0').toUpperCase()

export function colorToHex(css: string): string {
  const match = /^rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)(?:[ ,/]+([\d.]+%?))?\s*\)$/.exec(css.trim())
  if (!match) return css.trim()
  const [r, g, b] = [match[1], match[2], match[3]].map(Number)
  let alpha = 1
  if (match[4] !== undefined) alpha = match[4].endsWith('%') ? parseFloat(match[4]) / 100 : parseFloat(match[4])
  if (alpha === 0) return 'transparent'
  return `#${hex(r)}${hex(g)}${hex(b)}${alpha < 1 ? hex(Math.round(alpha * 255)) : ''}`
}

const num = (value: string) => {
  const n = parseFloat(value)
  return Number.isFinite(n) ? String(Math.round(n * 100) / 100) : value
}

function fontPart(styles: Record<string, string>): string {
  const family = (styles.fontFamily || '').split(',')[0].trim().replace(/^["']|["']$/g, '')
  const size = num(styles.fontSize)
  const lineHeight = styles.lineHeight === 'normal' ? 'normal' : num(styles.lineHeight)
  const parts = [family, `${size}/${lineHeight}`, styles.fontWeight, colorToHex(styles.color)]
  if (styles.textAlign && !['start', 'left'].includes(styles.textAlign)) parts.push(styles.textAlign)
  if (styles.textTransform && styles.textTransform !== 'none') parts.push(styles.textTransform)
  if (styles.textDecoration && styles.textDecoration !== 'none') parts.push(styles.textDecoration)
  if (styles.letterSpacing && styles.letterSpacing !== 'normal' && parseFloat(styles.letterSpacing) !== 0) parts.push(`ls ${num(styles.letterSpacing)}`)
  return parts.filter(Boolean).join(' ')
}

const isZero = (value: string | undefined) => !value || value.split(' ').every((part) => part === '0')

function boxParts(styles: Record<string, string>): string[] {
  const parts: string[] = []
  const bg = styles.backgroundColor ? colorToHex(styles.backgroundColor) : 'transparent'
  if (bg !== 'transparent') parts.push(`bg ${bg}`)
  if (styles.backgroundImage && styles.backgroundImage !== 'none') parts.push(`bg-image ${styles.backgroundImage}`)
  const border = styles.border || ''
  if (border && !border.startsWith('0 ') && !/ none /.test(` ${border} `)) {
    const [width, style, ...color] = border.split(' ')
    parts.push(`border ${width} ${style} ${colorToHex(color.join(' '))}`)
  }
  if (styles.borderRadius && parseFloat(styles.borderRadius) > 0) parts.push(`radius ${num(styles.borderRadius)}`)
  if (styles.shadow === 'yes') parts.push('shadow')
  if (!isZero(styles.padding)) parts.push(`p ${styles.padding}`)
  if (!isZero(styles.margin)) parts.push(`m ${styles.margin}`)
  if (styles.gap && styles.gap !== 'normal' && !isZero(styles.gap.replace(/px/g, ''))) parts.push(`gap ${styles.gap.replace(/px/g, '')}`)
  if (styles.flex) parts.push(`flex ${styles.flex}`)
  if (styles.opacity && styles.opacity !== '1') parts.push(`opacity ${styles.opacity}`)
  return parts
}

export function formatNodeLine(node: LiveNode, index: number): string {
  const text = node.text.length > 70 ? `${node.text.slice(0, 67)}…` : node.text
  const label = text ? ` "${text.replace(/"/g, '\'')}"` : ''
  const { x, y, width, height } = node.rect
  const head = `#${index} ${node.tag}${label} x${x} y${y} w${width} h${height}${node.positioned ? ` (${node.positioned})` : ''}`
  const detail: string[] = []
  if (node.tag === 'img') {
    const file = (node.src || '').split('?')[0].split('/').pop() || ''
    detail.push(`img ${node.natural || ''}${node.objectFit && node.objectFit !== 'fill' ? ` ${node.objectFit}` : ''}${file ? ` ${file}` : ''}`.trim())
  } else if (node.text) {
    detail.push(fontPart(node.styles))
  }
  const box = boxParts(node.styles)
  if (box.length) detail.push(box.join(', '))
  return detail.length ? `${head} | ${detail.join(' | ')}` : head
}

export interface NodeLines {
  lines: string[]
  total: number
  omitted: number
}

/** Lines for one section, text and images first, in reading order, capped. */
export function formatSectionNodes(nodes: LiveNode[], sectionId: string, max = 80): NodeLines {
  const picked = nodes
    .map((node, index) => ({ node, index }))
    .filter((item) => item.node.sectionId === sectionId)
  const rank = (node: LiveNode) => (node.text || node.tag === 'img' ? 0 : 1)
  const ordered = [...picked].sort((a, b) => rank(a.node) - rank(b.node) || a.node.rect.y - b.node.rect.y || a.node.rect.x - b.node.rect.x)
  const shown = ordered.slice(0, max).sort((a, b) => a.node.rect.y - b.node.rect.y || a.node.rect.x - b.node.rect.x)
  return { lines: shown.map((item) => formatNodeLine(item.node, item.index)), total: picked.length, omitted: Math.max(0, picked.length - shown.length) }
}
