import { useEffect, useRef, useState } from 'react'

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const RATE = 260
const MAX_DELAY = 1200

/** Presentation only. Saved replies and copy actions retain the complete received text. */
export function useTypedReply(text: string, animateInitially: boolean) {
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  const [shown, setShown] = useState(() => animateInitially && !reduced ? '' : text)
  const displayed = useRef(shown)
  const target = useRef({ text, ends: [] as number[], deadline: 0 })
  const frame = useRef<number | null>(null)
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const change = () => setReduced(media.matches)
    media.addEventListener('change', change)
    return () => media.removeEventListener('change', change)
  }, [])
  useEffect(() => () => { if (frame.current !== null) window.cancelAnimationFrame(frame.current); frame.current = null }, [])
  useEffect(() => {
    const reveal = (value: string) => { displayed.current = value; setShown(value) }
    const stop = () => { if (frame.current !== null) window.cancelAnimationFrame(frame.current); frame.current = null }
    // Corrections and reduced motion show accurate text immediately; histories never replay.
    if (reduced || document.hidden || !text.startsWith(displayed.current)) { stop(); reveal(text); return }
    target.current = { text, ends: [...segmenter.segment(text)].map(part => part.index + part.segment.length), deadline: performance.now() + MAX_DELAY }
    if (text === displayed.current) { stop(); return }
    // Keep one frame pump alive when fast streaming deltas arrive between frames.
    if (frame.current !== null) return
    let previous = performance.now()
    const tick = (now: number) => {
      const current = target.current
      if (document.hidden) { reveal(current.text); frame.current = null; return }
      const elapsed = Math.min(48, Math.max(1, now - previous))
      previous = now
      let low = 0, high = current.ends.length
      while (low < high) { const middle = (low + high) >>> 1; if (current.ends[middle] <= displayed.current.length) low = middle + 1; else high = middle }
      const count = Math.max(1, Math.ceil(elapsed * Math.max(RATE / 1000, (current.ends.length - low) / Math.max(48, current.deadline - now))))
      const next = Math.min(current.ends.length, low + count)
      reveal(current.text.slice(0, current.ends[next - 1]))
      frame.current = next < current.ends.length ? window.requestAnimationFrame(tick) : null
    }
    frame.current = window.requestAnimationFrame(tick)
  }, [text, reduced])
  return shown
}
