export type Breakpoint = 'desktop' | 'tablet' | 'mobile'
export const BREAKPOINTS: readonly Breakpoint[] = ['desktop', 'tablet', 'mobile']

/** Common design-frame widths per breakpoint, in CSS px. */
const KNOWN_FRAME_WIDTHS: Record<Breakpoint, readonly number[]> = {
  desktop: [1920, 1680, 1600, 1536, 1440, 1366, 1280],
  tablet: [1180, 1024, 834, 820, 810, 800, 768, 744],
  mobile: [440, 430, 428, 414, 412, 402, 393, 390, 375, 360, 320],
}

/** Export scales in order of preference. 1.5x is rare, so it is tried last. */
const SCALE_ORDER = [1, 2, 3, 4, 1.5] as const

export type DesignScaleDetection = 'filename' | 'dimensions' | 'slot' | 'fallback'

export interface DesignScaleResult {
  scale: number
  frameWidth: number
  breakpoint: Breakpoint
  detection: DesignScaleDetection
  confidence: 'high' | 'low'
}

/** Under 600 is mobile, 600-1199 is tablet, 1200 and up is desktop. */
export function breakpointForFrameWidth(frameWidth: number): Breakpoint {
  if (frameWidth < 600) return 'mobile'
  if (frameWidth < 1200) return 'tablet'
  return 'desktop'
}

export function isBreakpoint(value: unknown): value is Breakpoint {
  return typeof value === 'string' && (BREAKPOINTS as readonly string[]).includes(value)
}

const FILENAME_SCALE = /@(1\.5|2|3|4)x(?=\.|$|[^a-z0-9])/i

/**
 * Work out how many design pixels make one CSS pixel. A scale in the file name
 * (`home@2x.png`) wins. Otherwise the scale whose resulting frame width matches a
 * common frame width is chosen, preferring the slot the image was dropped on and
 * then the lowest scale. Images that match nothing get a low-confidence guess.
 */
export function detectDesignScale(input: { pixelWidth: number; fileName?: string; slotHint?: Breakpoint }): DesignScaleResult {
  const pixelWidth = Math.round(input.pixelWidth)
  if (!Number.isFinite(pixelWidth) || pixelWidth < 1) throw new Error('Invalid image width.')

  const named = input.fileName ? FILENAME_SCALE.exec(input.fileName) : null
  if (named) {
    const scale = Number(named[1])
    const frameWidth = Math.round(pixelWidth / scale)
    return { scale, frameWidth, breakpoint: input.slotHint ?? breakpointForFrameWidth(frameWidth), detection: 'filename', confidence: 'high' }
  }

  const matches: Array<{ scale: number; frameWidth: number; breakpoint: Breakpoint }> = []
  for (const scale of SCALE_ORDER) {
    const frameWidth = pixelWidth / scale
    for (const breakpoint of BREAKPOINTS) {
      if (KNOWN_FRAME_WIDTHS[breakpoint].some((known) => Math.abs(known - frameWidth) <= 1)) {
        matches.push({ scale, frameWidth: Math.round(frameWidth), breakpoint })
        break
      }
    }
  }
  if (matches.length) {
    const hinted = input.slotHint ? matches.find((match) => match.breakpoint === input.slotHint) : undefined
    const chosen = hinted ?? matches[0]
    return { ...chosen, detection: hinted ? 'slot' : 'dimensions', confidence: 'high' }
  }

  const scale = pixelWidth > 2000 ? 2 : 1
  const frameWidth = Math.round(pixelWidth / scale)
  return { scale, frameWidth, breakpoint: input.slotHint ?? breakpointForFrameWidth(frameWidth), detection: 'fallback', confidence: 'low' }
}

/**
 * After designs were just added, which breakpoint the viewport should move to so the person sees
 * them: none when one of them is for the breakpoint already showing, otherwise the first one added.
 */
export function breakpointToFollow(added: Breakpoint[], showing: Breakpoint): Breakpoint | null {
  if (!added.length || added.includes(showing)) return null
  return added[0]
}
