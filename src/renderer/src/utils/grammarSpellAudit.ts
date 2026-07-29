export interface TextIssue {
  id: string
  type: 'spelling' | 'grammar'
  wordOrPhrase: string
  suggestion?: string
  message: string
  elementTag: string
  elementSnippet: string
  elementIndex: number
  fullText: string
}

export interface GrammarSpellReport {
  totalIssues: number
  spellingCount: number
  grammarCount: number
  issues: TextIssue[]
}

export async function runGrammarSpellAuditAsync(docOrHtml: Document | string): Promise<GrammarSpellReport> {
  let doc: Document

  if (typeof docOrHtml === 'string') {
    const parser = new DOMParser()
    doc = parser.parseFromString(docOrHtml, 'text/html')
  } else {
    doc = docOrHtml
  }

  if (!doc || !doc.body) {
    return { totalIssues: 0, spellingCount: 0, grammarCount: 0, issues: [] }
  }

  const candidateElements = Array.from(
    doc.body.querySelectorAll('p, h1, h2, h3, h4, h5, h6, span, a, li, button, td, th, label, div, section, article')
  )

  const textElements: Element[] = []
  candidateElements.forEach((el) => {
    const tag = el.tagName.toLowerCase()
    if (tag === 'script' || tag === 'style' || tag === 'svg' || tag === 'code' || tag === 'pre') return

    const hasTextChildElements = Array.from(el.children).some((c) => {
      const cTag = c.tagName.toLowerCase()
      return ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'td', 'th', 'button', 'a'].includes(cTag)
    })
    if (hasTextChildElements) return

    const text = (el.textContent || '').replace(/\s+/g, ' ').trim()
    if (text.length > 2) {
      textElements.push(el)
    }
  })

  const payload = textElements.map((el, idx) => ({
    id: `el_${idx}`,
    tag: el.tagName.toLowerCase(),
    text: (el.textContent || '').trim(),
    index: idx
  }))

  try {
    if (typeof window.electronAPI?.runGrammarSpellAudit === 'function') {
      const res = await window.electronAPI.runGrammarSpellAudit(payload)
      if (res && Array.isArray(res.issues)) {
        return res
      }
    }
  } catch (err) {
    console.warn('[GrammarSpellAudit] Error calling main IPC handler:', err)
  }

  return { totalIssues: 0, spellingCount: 0, grammarCount: 0, issues: [] }
}

export function runGrammarSpellAudit(docOrHtml: Document | string): GrammarSpellReport {
  return { totalIssues: 0, spellingCount: 0, grammarCount: 0, issues: [] }
}
