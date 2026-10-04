// Turns the page's top-level content blocks into numbered sections (S1, S2, …) that the
// QA agent maps to the design. Pure so it can be tested without a browser.

export interface RawBlock {
  tag: string
  selector: string
  top: number
  height: number
  label: string
  bg?: string
  bgImage?: string
  bgFixed?: boolean
}

export interface PageSection extends RawBlock {
  id: string
}

export const MIN_SECTION_HEIGHT = 60
export const MAX_SECTIONS = 60

const tidy = (value: string) => value.replace(/\s+/g, ' ').trim().slice(0, 80)

export function finalizeSections(blocks: RawBlock[], pageHeight: number): PageSection[] {
  const sorted = blocks
    .filter((block) => Number.isFinite(block.top) && Number.isFinite(block.height) && block.height >= 8)
    .map((block) => ({ ...block, top: Math.max(0, Math.round(block.top)), height: Math.round(block.height), label: tidy(block.label) }))
    .sort((a, b) => a.top - b.top || b.height - a.height)

  const merged: RawBlock[] = []
  for (const block of sorted) {
    const previous = merged[merged.length - 1]
    if (previous) {
      const previousEnd = previous.top + previous.height
      // A block that sits inside the previous one is a nested duplicate, not a new section.
      if (block.top >= previous.top && block.top + block.height <= previousEnd + 2) continue
      // A thin strip belongs to the section above it.
      if (block.height < MIN_SECTION_HEIGHT) {
        previous.height = Math.max(previous.height, block.top + block.height - previous.top)
        continue
      }
    }
    merged.push({ ...block })
  }

  // A thin first strip joins the section below it.
  if (merged.length > 1 && merged[0].height < MIN_SECTION_HEIGHT) {
    const [first, second] = merged
    second.height = second.top + second.height - first.top
    second.top = first.top
    merged.shift()
  }

  const limit = Math.max(1, Math.round(pageHeight))
  return merged
    .map((block) => ({ ...block, height: Math.min(block.height, Math.max(0, limit - block.top)) }))
    .filter((block) => block.height >= 8)
    .slice(0, MAX_SECTIONS)
    .map((block, index) => ({ ...block, id: `S${index + 1}`, label: block.label || `${block.tag} section` }))
}

/** Index of the section containing a page y position, or -1 when none does. */
export function sectionIdAt(sections: PageSection[], y: number): string | null {
  for (const section of sections) {
    if (y >= section.top && y < section.top + section.height) return section.id
  }
  return null
}
