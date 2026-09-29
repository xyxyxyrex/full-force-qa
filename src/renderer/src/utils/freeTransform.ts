export interface FreeTransformRect {
  left: number
  top: number
  width: number
  height: number
}

export interface FreeTransformResizeResult {
  rect: FreeTransformRect
  scaleX: number
  scaleY: number
}

const MIN_SCALE = 0.001

export function calculateFreeTransformResize(
  rect: FreeTransformRect,
  horizontal: -1 | 0 | 1,
  vertical: -1 | 0 | 1,
  deltaX: number,
  deltaY: number,
  stretchCorners: boolean,
): FreeTransformResizeResult {
  const safeWidth = Math.max(1, rect.width)
  const safeHeight = Math.max(1, rect.height)
  let scaleX = horizontal ? 1 + horizontal * deltaX / safeWidth : 1
  let scaleY = vertical ? 1 + vertical * deltaY / safeHeight : 1

  if (horizontal && vertical && !stretchCorners) {
    const factor = 1 + (
      horizontal * deltaX * safeWidth + vertical * deltaY * safeHeight
    ) / (safeWidth * safeWidth + safeHeight * safeHeight)
    scaleX = factor
    scaleY = factor
  }

  scaleX = Math.max(MIN_SCALE, Math.max(1 / safeWidth, scaleX))
  scaleY = Math.max(MIN_SCALE, Math.max(1 / safeHeight, scaleY))
  const width = Math.max(1, safeWidth * scaleX)
  const height = Math.max(1, safeHeight * scaleY)

  return {
    scaleX,
    scaleY,
    rect: {
      left: horizontal < 0 ? rect.left + safeWidth - width : rect.left,
      top: vertical < 0 ? rect.top + safeHeight - height : rect.top,
      width,
      height,
    },
  }
}

export function signedPixels(value: number) {
  const rounded = Math.round(value)
  return `${rounded >= 0 ? '+' : '−'}${Math.abs(rounded)}`
}

export function scalePercent(value: number) {
  return `${Math.round(value * 100)}%`
}
