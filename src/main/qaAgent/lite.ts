import type { Breakpoint } from '../../shared/designScale'

// How much an agent on a free tier does. Free tiers allow a few requests a minute and somewhere
// between fifty and a few thousand a day, while a full review is hundreds of requests (three
// breakpoints, each section, then the functional test). A lite run does less, and says so, so
// that it finishes inside the allowance instead of stopping halfway.

export const LITE_LIMITS = {
  /** Requests one chat message may use. */
  chatTurns: 24,
  /** Requests one breakpoint's look may use. */
  breakpointTurns: 30,
  /** Requests the functional test of one page may use. */
  functionalTurns: 24,
}

/** The breakpoints a lite review covers when none were asked for: desktop if it is among them, else the first. */
export function liteBreakpoints(available: Breakpoint[]): Breakpoint[] {
  if (!available.length) return ['desktop']
  return available.includes('desktop') ? ['desktop'] : [available[0]]
}

export const LITE_NOTE = 'Free model: a lighter run (fewer steps, one breakpoint unless you name more, no functional test unless you ask for one).'
