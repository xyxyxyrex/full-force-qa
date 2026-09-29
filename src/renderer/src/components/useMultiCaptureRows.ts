import { useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { parseMultiCaptureInput } from '../utils/multiCapture'

export type MultiCaptureRowStatus = 'idle' | 'saving' | 'saved' | 'failed' | 'skipped' | 'stopped'

export interface MultiCaptureRow {
  id: string
  projectId: string
  url: string
  name: string
  parseError?: string
  status: MultiCaptureRowStatus
  saveError?: string
}

export const createMultiCaptureRow = (url = '', parseError?: string): MultiCaptureRow => ({
  id: crypto.randomUUID(),
  projectId: crypto.randomUUID(),
  url,
  name: '',
  parseError,
  status: 'idle',
})

export interface MultiCaptureRowsState {
  rows: MultiCaptureRow[]
  setRows: Dispatch<SetStateAction<MultiCaptureRow[]>>
  focusRowId: string | null
  clearFocusRow: () => void
  updateRow: (id: string, patch: Partial<MultiCaptureRow>) => void
  appendParsed: (input: string, replaceRowId?: string) => boolean
  addBlankRow: () => void
}

export function useMultiCaptureRows(): MultiCaptureRowsState {
  const [rows, setRows] = useState<MultiCaptureRow[]>([createMultiCaptureRow()])
  const [focusRowId, setFocusRowId] = useState<string | null>(null)

  const updateRow = (id: string, patch: Partial<MultiCaptureRow>) => {
    setRows(current => current.map(row => row.id === id ? { ...row, ...patch } : row))
  }

  const appendParsed = (input: string, replaceRowId?: string) => {
    const parsed = parseMultiCaptureInput(input)
    if (!parsed.length) return false
    const additions = parsed.map(item => createMultiCaptureRow(item.value, item.error))
    setRows(current => {
      if (replaceRowId) {
        const index = current.findIndex(row => row.id === replaceRowId)
        if (index >= 0) {
          const existing = current[index]
          additions[0] = { ...additions[0], id: existing.id, projectId: existing.projectId, name: existing.name }
          return [...current.slice(0, index), ...additions, ...current.slice(index + 1)]
        }
      }
      const onlyBlank = current.length === 1 && !current[0].url.trim() && !current[0].name.trim()
      return onlyBlank ? additions : [...current, ...additions]
    })
    setFocusRowId(additions[additions.length - 1].id)
    return true
  }

  const addBlankRow = () => {
    const row = createMultiCaptureRow()
    setFocusRowId(row.id)
    setRows(current => [...current, row])
  }

  return {
    rows,
    setRows,
    focusRowId,
    clearFocusRow: () => setFocusRowId(null),
    updateRow,
    appendParsed,
    addBlankRow,
  }
}
