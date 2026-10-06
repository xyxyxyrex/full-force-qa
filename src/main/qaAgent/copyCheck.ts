import type nspell from 'nspell'
import { isAcceptedSpelling } from '../spellingHeuristics'

// The copy check behind the check_text tool: possible misspellings (Hunspell, US English, the same
// dictionary as the SEO audit), placeholder text, doubled words and repeated blocks. It runs on
// the text the page shows, so it costs the agent no picture.

export interface TextBlock { ref: string; tag: string; text: string }

export interface CopyReport {
  blocks: number
  words: number
  /** Null when the dictionary could not be loaded. */
  misspellings: Array<{ word: string; count: number; suggestions: string[]; ref: string; context: string }> | null
  placeholders: Array<{ match: string; ref: string; context: string }>
  doubledWords: Array<{ match: string; ref: string; context: string }>
  repeatedBlocks: Array<{ text: string; count: number; refs: string[] }>
}

type Speller = ReturnType<typeof nspell>
let loading: Promise<Speller | null> | null = null

/** The dictionary, loaded once on first use (both modules only then, so nothing loads them until a check runs). Null when it could not be loaded. */
export function loadSpeller(): Promise<Speller | null> {
  loading ??= (async () => {
    try {
      const [speller, module]: [any, any] = await Promise.all([import('nspell'), import('dictionary-en')])
      const create: typeof nspell = speller.default || speller
      const dictionary = module.default || module
      return dictionary?.aff && dictionary?.dic ? create(dictionary) : null
    } catch { return null }
  })()
  return loading
}

const PLACEHOLDER = /lorem ipsum|dolor sit amet|\b(your|the) (text|title|heading|content|headline|description) (goes )?here\b|\binsert [\w ]{1,30} here\b|\b(sample|dummy|placeholder|filler) (text|copy|content)\b|\b(TBD|TODO|FIXME)\b|\bx{3,}\b|\[(insert|add|placeholder)[^\]]*\]|\bclick here\b/i
// "that that" and "had had" can be right, so a doubled word is listed for a look, not reported as wrong.
const DOUBLED = /\b([a-z]{2,})\s+\1\b/i
const LOREM = /lorem ipsum|dolor sit amet|consectetur adipiscing/i
const MAX_MISSPELLINGS = 40
const MAX_SUGGESTED = 25

const contextOf = (text: string, index: number, length: number) => {
  const start = Math.max(0, index - 30)
  return `${start > 0 ? '…' : ''}${text.slice(start, index + length + 30)}${index + length + 30 < text.length ? '…' : ''}`
}

/** Words a dictionary should not judge: addresses, numbers, acronyms, CamelCase names. */
function wordsOf(text: string): Array<{ word: string; index: number }> {
  const stripped = text.replace(/\S+@\S+|https?:\/\/\S+|www\.\S+|\S+\.(com|net|org|io|co|uk|au)\b\S*/gi, (match) => ' '.repeat(match.length))
  const out: Array<{ word: string; index: number }> = []
  for (const match of stripped.matchAll(/[A-Za-z][A-Za-z'’]*[A-Za-z]/g)) {
    const word = match[0].replace(/['’]s$/i, '').replace(/['’]/g, "'")
    if (word.length < 3 || /^[A-Z]+$/.test(word) || /[a-z][A-Z]/.test(word) || word.includes("'")) continue
    if (/\d/.test(text.slice(match.index - 1, match.index)) || /\d/.test(text.charAt(match.index + match[0].length))) continue
    out.push({ word, index: match.index })
  }
  return out
}

export function checkCopy(input: { blocks: TextBlock[]; title?: string; host?: string }, speller: Speller | null): CopyReport {
  const { blocks } = input
  // Words in the site's name and title are names, not typos.
  const own = new Set(`${input.host ?? ''} ${input.title ?? ''}`.toLowerCase().split(/[^a-z]+/).filter(Boolean))
  const placeholders: CopyReport['placeholders'] = []
  const doubledWords: CopyReport['doubledWords'] = []
  const seen = new Map<string, { word: string; count: number; ref: string; context: string }>()
  let words = 0
  for (const block of blocks) {
    const placeholder = PLACEHOLDER.exec(block.text)
    if (placeholder && placeholders.length < 15) placeholders.push({ match: placeholder[0], ref: block.ref, context: contextOf(block.text, placeholder.index, placeholder[0].length) })
    const doubled = DOUBLED.exec(block.text)
    if (doubled && doubledWords.length < 15) doubledWords.push({ match: doubled[0], ref: block.ref, context: contextOf(block.text, doubled.index, doubled[0].length) })
    // Lorem ipsum is reported once as placeholder text, not word by word as misspellings.
    if (LOREM.test(block.text)) continue
    for (const { word, index } of wordsOf(block.text)) {
      words++
      const key = word.toLowerCase()
      const known = seen.get(key)
      if (known) known.count++
      else seen.set(key, { word, count: 1, ref: block.ref, context: contextOf(block.text, index, word.length) })
    }
  }

  let misspellings: CopyReport['misspellings'] = null
  if (speller) {
    const flagged = [...seen.entries()]
      // A word used three times or more is the site's own term (a product, a place, jargon).
      .filter(([key, entry]) => entry.count < 3 && !own.has(key) && !isAcceptedSpelling(speller, entry.word))
      .map(([, entry]) => entry)
      // Lower-case words first: a capitalised one is more often a name.
      .sort((a, b) => Number(/^[A-Z]/.test(a.word)) - Number(/^[A-Z]/.test(b.word)))
      .slice(0, MAX_MISSPELLINGS)
    misspellings = flagged.map((entry, index) => ({ ...entry, suggestions: index < MAX_SUGGESTED ? speller.suggest(entry.word).slice(0, 3) : [] }))
  }

  const repeats = new Map<string, { text: string; refs: string[] }>()
  for (const block of blocks) {
    if (block.text.length < 40) continue
    const key = block.text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    const entry = repeats.get(key) ?? { text: block.text, refs: [] }
    entry.refs.push(block.ref)
    repeats.set(key, entry)
  }
  const repeatedBlocks = [...repeats.values()].filter((entry) => entry.refs.length > 1).slice(0, 10).map((entry) => ({ text: entry.text.slice(0, 120), count: entry.refs.length, refs: entry.refs.slice(0, 4) }))

  return { blocks: blocks.length, words, misspellings, placeholders, doubledWords, repeatedBlocks }
}
