export interface RemarkStyle {
  tone: 'direct' | 'professional' | 'friendly'
  technicality: 0 | 1 | 2
  detail: 0 | 1 | 2
  formatting: boolean
}
export const DEFAULT_REMARK_STYLE: RemarkStyle = { tone: 'professional', technicality: 1, detail: 1, formatting: false }
export function normalizeRemarkStyle(value: unknown): RemarkStyle {
  const raw = value && typeof value === 'object' ? value as Partial<RemarkStyle> : {}
  return { tone: ['direct', 'professional', 'friendly'].includes(raw.tone || '') ? raw.tone! : 'professional',
    technicality: [0, 1, 2].includes(raw.technicality!) ? raw.technicality! : 1,
    detail: [0, 1, 2].includes(raw.detail!) ? raw.detail! : 1, formatting: raw.formatting === true }
}
export const remarkLimit = (style?: RemarkStyle) => [200, 600, 1200][normalizeRemarkStyle(style).detail]
export function remarkGuide(value?: RemarkStyle): string {
  const style = normalizeRemarkStyle(value)
  return `Write one issue per remark in a ${style.tone} tone. ${[
    'Use plain language and explain necessary technical terms.', 'Use familiar developer terms with enough context to be understandable.', 'Use precise CSS properties and technical terms when they are verified.',
  ][style.technicality]} ${[
    'Keep it brief and actionable, normally one short sentence.', 'Use one or two complete sentences explaining the issue and fix.', 'Explain the observed behavior, expected behavior, and fix in a short paragraph when verified.',
  ][style.detail]} Use natural punctuation, including commas where appropriate. Maximum ${remarkLimit(style)} characters. ${style.formatting ? 'Optional light **bold emphasis** and `inline code` are allowed; avoid headings, tables and excessive formatting.' : 'Use plain text without Markdown formatting.'} Never invent measurements or causes. Breakpoints belong in Display. User style overrides example wording; example columns and evidence rules still apply.`
}
export function stylePrompt(prompt: string, style?: RemarkStyle): string {
  return prompt.replace(/<remark-policy>[\s\S]*?<\/remark-policy>/g, `<remark-policy>\n${remarkGuide(style)}\n</remark-policy>`)
}
export interface RemarkSegment { text: string; bold?: boolean; code?: boolean }
export function remarkSegments(text: string): RemarkSegment[] {
  const result: RemarkSegment[] = []; const re = /\*\*([^*\n]+)\*\*|`([^`\n]+)`/g
  let offset = 0; let match: RegExpExecArray | null
  while ((match = re.exec(text))) { if (match.index > offset) result.push({ text: text.slice(offset, match.index) }); result.push({ text: match[1] || match[2], ...(match[1] ? { bold: true } : { code: true }) }); offset = re.lastIndex }
  if (offset < text.length) result.push({ text: text.slice(offset) })
  return result
}
export const plainRemark = (text: string) => remarkSegments(text).map(part => part.text).join('')
export function remarkExample(value: RemarkStyle): string {
  const style = normalizeRemarkStyle(value)
  const term = style.technicality === 0 ? 'heading size' : style.technicality === 1 ? 'heading font size' : 'h1 font-size'
  let text = style.tone === 'direct' ? `Set the ${term} to 32px.` : style.tone === 'friendly' ? `Please increase the ${term} to 32px to match the design.` : `Increase the ${term} to 32px to match the design.`
  if (style.detail > 0) text += ' It currently renders at 28px, making the heading smaller than intended.'
  if (style.detail === 2) text += ' Apply the change to the hero heading, then check that its line breaks still match the design.'
  return style.formatting ? text.replace('32px', '**32px**').replace('h1 font-size', '`h1 font-size`') : text
}
