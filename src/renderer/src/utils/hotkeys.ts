import type { AppHotkeys } from '../../../shared/types'

type KeyboardLike = Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>

const MODIFIER_KEYS = new Set(['control', 'ctrl', 'alt', 'option', 'shift', 'meta', 'command', 'cmd'])

const normalizeKey = (key: string, code = ''): string => {
  const value = key.trim()
  const lower = value.toLowerCase()
  if (code === 'Space' || lower === 'space' || lower === 'spacebar' || value === ' ') return 'Space'
  if (lower === 'esc') return 'Escape'
  if (lower === 'del') return 'Delete'
  if (lower === 'return') return 'Enter'
  if (lower === 'arrowup' || lower === 'up') return 'ArrowUp'
  if (lower === 'arrowdown' || lower === 'down') return 'ArrowDown'
  if (lower === 'arrowleft' || lower === 'left') return 'ArrowLeft'
  if (lower === 'arrowright' || lower === 'right') return 'ArrowRight'
  if (/^f\d{1,2}$/i.test(value)) return value.toUpperCase()
  if (value.length === 1) return value.toUpperCase()
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : ''
}

export function normalizeHotkey(binding: string): string {
  if (!binding?.trim()) return ''
  const parts = binding.split('+').map((part) => part.trim()).filter(Boolean)
  let ctrl = false
  let alt = false
  let shift = false
  let meta = false
  let key = ''

  for (const part of parts) {
    const lower = part.toLowerCase()
    if (lower === 'ctrl' || lower === 'control') ctrl = true
    else if (lower === 'alt' || lower === 'option') alt = true
    else if (lower === 'shift') shift = true
    else if (lower === 'meta' || lower === 'command' || lower === 'cmd') meta = true
    else key = normalizeKey(part)
  }

  if (!key) return ''
  return [ctrl && 'Ctrl', alt && 'Alt', shift && 'Shift', meta && 'Meta', key].filter(Boolean).join(' + ')
}

export function hotkeyFromEvent(event: KeyboardLike): string {
  if (MODIFIER_KEYS.has(event.key.toLowerCase())) return ''
  const key = normalizeKey(event.key, event.code)
  if (!key) return ''
  return [
    event.ctrlKey && 'Ctrl',
    event.altKey && 'Alt',
    event.shiftKey && 'Shift',
    event.metaKey && 'Meta',
    key,
  ].filter(Boolean).join(' + ')
}

export function matchesHotkey(event: KeyboardLike, binding: string): boolean {
  const normalized = normalizeHotkey(binding)
  return !!normalized && normalized === hotkeyFromEvent(event)
}

export function findHotkeyCommand(
  event: KeyboardLike,
  hotkeys: AppHotkeys,
): keyof AppHotkeys | null {
  for (const [command, binding] of Object.entries(hotkeys) as Array<[keyof AppHotkeys, string]>) {
    if (matchesHotkey(event, binding)) return command
  }
  return null
}

export function isEditableHotkeyTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null
  return !!element?.closest?.('input, textarea, select, [contenteditable="true"], [role="textbox"]')
}

export function findHotkeyConflicts(hotkeys: AppHotkeys): Map<keyof AppHotkeys, Array<keyof AppHotkeys>> {
  const byBinding = new Map<string, Array<keyof AppHotkeys>>()
  for (const [command, binding] of Object.entries(hotkeys) as Array<[keyof AppHotkeys, string]>) {
    const normalized = normalizeHotkey(binding)
    if (!normalized) continue
    byBinding.set(normalized, [...(byBinding.get(normalized) || []), command])
  }
  const conflicts = new Map<keyof AppHotkeys, Array<keyof AppHotkeys>>()
  for (const commands of byBinding.values()) {
    if (commands.length < 2) continue
    for (const command of commands) conflicts.set(command, commands.filter((item) => item !== command))
  }
  return conflicts
}

export const RESERVED_HOTKEYS = new Set(['Ctrl + R', 'Meta + R', 'F5', 'F12', 'Ctrl + Shift + I', 'Meta + Alt + I'])

export function isReservedHotkey(binding: string): boolean {
  const normalized = normalizeHotkey(binding)
  if (!normalized) return false
  if (RESERVED_HOTKEYS.has(normalized)) return true
  const parts = new Set(normalized.split(' + '))
  const key = normalized.split(' + ').at(-1)
  // Electron's app-level handler treats any Ctrl/Meta + R variation as a
  // reload, including combinations with additional modifiers.
  if (key === 'R' && (parts.has('Ctrl') || parts.has('Meta'))) return true
  if (key === 'I' && parts.has('Ctrl') && parts.has('Shift')) return true
  if (key === 'I' && parts.has('Meta') && parts.has('Alt')) return true
  return false
}
