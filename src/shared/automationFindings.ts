import type { AutomationFinding, PixelComparison } from './automation'
import { stableId } from './automationText'

export function visualFindings(result: PixelComparison): AutomationFinding[] {
  const findings: AutomationFinding[] = []
  for (const axis of ['width', 'height'] as const) {
    const delta = result.live[axis] - result.design[axis]
    findings.push({
      id: stableId('page-dimension', axis), category: 'page-dimension',
      state: delta === 0 ? 'pass' : 'fail', evidenceStrength: 'deterministic',
      severity: delta === 0 ? 'pass' : 'medium', title: `Page ${axis}`,
      detail: 'Original screenshot dimensions; content outside the overlap is not pixel-compared.',
      expected: result.design[axis], actual: result.live[axis], difference: { [axis]: delta }
    })
  }
  const region = (rect: {x:number;y:number;width:number;height:number}, size: {width:number;height:number}) =>
    ({ rect, pageWidth: size.width, pageHeight: size.height, label: 'Native screenshot coordinates' })
  for (const changed of result.regions) {
    findings.push({
      id: stableId('pixel', String(changed.x), String(changed.y), String(changed.width), String(changed.height)),
      category: 'visual', state: 'visual', evidenceStrength: 'visual', severity: 'low',
      title: 'Visual difference detected',
      detail: 'Changed pixels at the same coordinates. No DOM or CSS cause has been inferred.',
      expected: 'Design pixels', actual: 'Different live pixels',
      difference: { pixels: changed.pixels, percent: changed.percent },
      comparison: { design: region(changed, result.design), live: region(changed, result.live) }
    })
  }
  if (!result.changedPixels) findings.push({
    id: stableId('pixel-overlap'), state: 'pass', evidenceStrength: 'deterministic', category: 'visual',
    severity: 'pass', title: 'No changed pixels in the compared overlap',
    detail: 'This applies only to the overlap and configured rendering tolerance, not whole-page conformance.',
    expected: 0, actual: 0, difference: { pixels: 0 }
  })
  return findings
}
