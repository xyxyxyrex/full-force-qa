import { parentPort, workerData } from 'node:worker_threads'
import { comparePixels } from './pixelDiff'
import { decodeScreenshot, encodeMask } from './imageLoader'

try {
  const result = comparePixels(decodeScreenshot(workerData.design), decodeScreenshot(workerData.live))
  const { mask, ...metrics } = result
  parentPort?.postMessage({ success: true, result: { ...metrics, diffDataUrl: encodeMask(mask, result.overlap.width, result.overlap.height) } })
} catch (error) {
  parentPort?.postMessage({ success: false, error: error instanceof Error ? error.message : String(error) })
}
