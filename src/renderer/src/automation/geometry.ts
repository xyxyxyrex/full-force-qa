import type { Bounds, Difference } from '../../../shared/automation'
import { AUTOMATION_TOLERANCE as tolerance } from '../../../shared/automationTolerance'

/** Native document coordinates. Never fit, scale, center, or subtract observed drift. */
export function compareGeometry(expected: Bounds, actual: Bounds) {
  const difference: Difference = {
    x: actual.x - expected.x, y: actual.y - expected.y,
    width: actual.width - expected.width, height: actual.height - expected.height
  }
  return {
    difference,
    positionPass: Math.abs(difference.x!) <= tolerance.positionPx && Math.abs(difference.y!) <= tolerance.positionPx,
    sizePass: Math.abs(difference.width!) <= tolerance.dimensionPx && Math.abs(difference.height!) <= tolerance.dimensionPx
  }
}
