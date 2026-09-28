export function comparisonWipeFromDrag(
  start: { x: number; y: number; reveal: number; opacity: number },
  current: { x: number; y: number },
  width: number,
) {
  const clamp = (value: number) => Math.max(0, Math.min(100, value))
  return {
    reveal: clamp(start.reveal + (current.x - start.x) / Math.max(1, width) * 100),
    opacity: clamp(start.opacity - (current.y - start.y) / 2),
  }
}
