import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentId, AgentModelList } from '../../../../shared/qaAgent'

export type ModelDiscoveryState = AgentModelList & { status: 'idle' | 'loading' | 'loaded' }
export const EMPTY_MODELS: ModelDiscoveryState = { models: [], status: 'idle' }
export function useModelDiscovery() {
  const [results, setResults] = useState<Partial<Record<AgentId, ModelDiscoveryState>>>({})
  const versions = useRef<Partial<Record<AgentId, number>>>({})
  const pending = useRef(new Set<AgentId>())
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false; for (const id of Object.keys(versions.current) as AgentId[]) versions.current[id] = (versions.current[id] || 0) + 1; pending.current.clear() } }, [])
  const invalidate = useCallback((id: AgentId) => {
    versions.current[id] = (versions.current[id] || 0) + 1
    pending.current.delete(id)
    setResults(previous => ({ ...previous, [id]: EMPTY_MODELS }))
  }, [])
  const load = useCallback(async (id: AgentId) => {
    if (pending.current.has(id)) return
    pending.current.add(id)
    const version = (versions.current[id] || 0) + 1
    versions.current[id] = version
    setResults(previous => ({ ...previous, [id]: { ...(previous[id] || EMPTY_MODELS), error: undefined, status: 'loading' } }))
    try {
      const result = await window.electronAPI.qaAgentsModels(id)
      if (alive.current && versions.current[id] === version) setResults(previous => ({ ...previous, [id]: { ...result, models: result.error ? previous[id]?.models || [] : result.models, options: result.error ? previous[id]?.options : result.options, status: 'loaded' } }))
    } catch {
      if (alive.current && versions.current[id] === version) setResults(previous => ({ ...previous, [id]: { ...(previous[id] || EMPTY_MODELS), status: 'loaded', error: 'Could not load models. Check your connection and provider sign-in, then refresh models.' } }))
    } finally { if (versions.current[id] === version) pending.current.delete(id) }
  }, [])
  return { results, load, invalidate }
}
