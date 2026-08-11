export interface ResolvedScrollPosition {
  top: number
  clampedToEnd: boolean
}

const finiteNonNegative = (value: number): number =>
  Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0

export function createCaptureScrollPositions(
  documentHeight: number,
  viewportHeight: number,
  scrollRange: number,
): number[] {
  const height = Math.max(1, finiteNonNegative(documentHeight))
  const viewport = Math.max(1, finiteNonNegative(viewportHeight))
  const measuredRange = finiteNonNegative(scrollRange)
  const maxScroll = Math.min(measuredRange, Math.max(0, height - 1))
  if (maxScroll === 0) return [0]

  const overlap = Math.min(180, Math.max(64, Math.round(viewport * 0.12)))
  const stride = Math.max(1, viewport - overlap)
  const positions: number[] = []
  for (let top = 0; top < maxScroll; top += stride) positions.push(top)
  if (positions.at(-1) !== maxScroll) positions.push(maxScroll)
  return positions
}

export function resolveCaptureScrollPosition(
  requestedTop: number,
  actualTop: number,
  currentMaxScroll: number,
  tolerance = 3,
): ResolvedScrollPosition | null {
  const requested = finiteNonNegative(requestedTop)
  const actual = finiteNonNegative(actualTop)
  const maximum = finiteNonNegative(currentMaxScroll)
  const allowedDifference = Math.max(0, tolerance)

  if (Math.abs(actual - requested) <= allowedDifference) {
    return { top: actual, clampedToEnd: false }
  }
  if (
    requested > maximum + allowedDifference &&
    Math.abs(actual - maximum) <= allowedDifference
  ) {
    return { top: actual, clampedToEnd: true }
  }
  return null
}
