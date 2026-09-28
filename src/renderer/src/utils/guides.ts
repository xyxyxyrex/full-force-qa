export interface CanvasGuide {
  axis: 'x' | 'y'
  position: number
}

export function guidePositionFromViewport(
  axis: CanvasGuide['axis'],
  clientX: number,
  clientY: number,
  viewport: { left: number; top: number; width: number; height: number },
  scale: number,
  snapDistance = 8,
): { px: number; ratio: number; screenX: number; screenY: number; snapped: boolean } {
  const dimension = axis === 'x' ? viewport.height : viewport.width
  const edge = axis === 'x' ? viewport.top : viewport.left
  const pointer = axis === 'x' ? clientY : clientX
  const relative = pointer - edge
  const snapped = dimension > 0 && Math.abs(relative - dimension / 2) <= snapDistance
  const ratio = dimension > 0 ? (snapped ? 0.5 : relative / dimension) : 0
  const screenPosition = edge + ratio * dimension
  return {
    px: Math.round((ratio * dimension) / Math.max(scale, 0.01)),
    ratio,
    screenX: axis === 'y' ? screenPosition : clientX,
    screenY: axis === 'x' ? screenPosition : clientY,
    snapped,
  }
}

export function finishGuideGesture<T extends CanvasGuide>(
  guides: T[],
  index: number,
  start: { x: number; y: number },
  end: { x: number; y: number },
  position: number,
  outside: boolean,
  cancelled: boolean,
): T[] {
  if (cancelled || index < 0 || index >= guides.length) return guides
  const moved = Math.hypot(end.x - start.x, end.y - start.y) >= 4
  if (!moved || outside) return guides.filter((_, guideIndex) => guideIndex !== index)
  if (!Number.isFinite(position)) return guides
  return guides.map((guide, guideIndex) =>
    guideIndex === index ? { ...guide, position: Math.max(0, Math.min(1, position)) } : guide,
  )
}
