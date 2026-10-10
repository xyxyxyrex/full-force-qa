import type { QaExecutionSnapshot } from '../../../../shared/qaAgent'
import ChatIcon from './ChatIcon'

export default function ResponsePending({ running, responding, switching, execution, toolsPending }: {
  running: boolean
  responding: boolean
  switching?: boolean
  execution: QaExecutionSnapshot | null
  toolsPending: boolean
}) {
  if (!running || responding) return null
  const phase = execution?.running ? execution.phase : toolsPending ? 'tools' : 'waiting'
  const paused = !switching && (phase === 'approval' || phase === 'retrying')
  const label = switching ? 'Switching agents…'
    : phase === 'approval' ? 'Waiting for your approval'
    : phase === 'retrying' ? 'Waiting to retry…'
    : phase === 'tools' ? 'Checking the details…' : 'Thinking…'
  return <div className={`qa-response-pending${paused ? ' paused' : ''}`}>
    <div className="qa-response-pending-label" role="status" aria-live="polite" aria-atomic="true"><ChatIcon name="search" size={14}/><span>{label}</span></div>
    {!paused && <div className="qa-response-skeleton" aria-hidden="true"><i/><i/><i/></div>}
  </div>
}
