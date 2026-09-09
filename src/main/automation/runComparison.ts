import { Worker } from 'node:worker_threads'
import { join } from 'node:path'
import type { PixelComparisonResponse } from '../../shared/automation'

const jobs = new Map<string, () => void>()
export function cancelPixelComparison(jobId: string): boolean {
  const cancel = jobs.get(jobId)
  cancel?.()
  return !!cancel
}
export function runPixelComparison(jobId: string, design: string, live: string): Promise<PixelComparisonResponse> {
  if (jobs.size) return Promise.resolve({ success: false, error: 'A comparison is already running. Cancel it or wait for it to finish.' })
  return new Promise((resolve) => {
    const worker = new Worker(join(__dirname, 'automation-worker.js'), { workerData: { design, live } })
    let settled = false
    const finish = (result: PixelComparisonResponse) => {
      if (settled) return
      settled = true; clearTimeout(timeout); jobs.delete(jobId)
      void worker.terminate()
      resolve(result)
    }
    const timeout = setTimeout(() => finish({ success: false, error: 'Native-resolution comparison exceeded 90 seconds. No partial result was used.' }), 90_000)
    jobs.set(jobId, () => finish({ success: false, error: 'Comparison cancelled.' }))
    worker.once('message', finish)
    worker.once('error', (error) => finish({ success: false, error: error.message }))
    worker.once('exit', (code) => { if (!settled) finish({ success: false, error: `Comparison worker exited before returning evidence (${code}).` }) })
  })
}
