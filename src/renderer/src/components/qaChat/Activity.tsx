import { useEffect, useState } from 'react'
import type { QaExecutionSnapshot } from '../../../../shared/qaAgent'
export default function Activity({ execution, running }: { execution: QaExecutionSnapshot | null; running: boolean }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => { if (!running) return; setNow(Date.now()); const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer) }, [running, execution?.attemptId])
  if (!running) return null
  const seconds = execution ? Math.max(0, Math.floor((now - execution.phaseStartedAt) / 1000)) : 0
  const label = execution?.phase === 'retrying' ? `Retrying in ${Math.max(0, Math.ceil(((execution.retryAt || now) - now) / 1000))}s`
    : execution?.phase === 'tools' ? `Running tools · ${seconds}s` : execution?.phase === 'approval' ? 'Waiting for approval' : `Waiting for response · ${seconds}s`
  return <div className="qa-chat-activity" role="status" aria-live="off" title={execution ? `This attempt: ${Math.max(0, Math.floor((now - execution.startedAt) / 1000))}s · attempt ${execution.attempt}` : undefined}><span className="qa-activity-dot" aria-hidden="true"/>{label}</div>
}
