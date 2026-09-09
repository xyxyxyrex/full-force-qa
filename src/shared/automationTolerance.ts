export const AUTOMATION_TOLERANCE = Object.freeze({
  positionPx: 3,
  dimensionPx: 3,
  spacingPx: 3,
  fontSizePx: 1,
  lineHeightPx: 2,
  letterSpacingPx: 0.5,
  colorDelta: 2.3,
  pixelThreshold: 0.1,
  includeAA: false,
})
export type AutomationTolerance = typeof AUTOMATION_TOLERANCE
