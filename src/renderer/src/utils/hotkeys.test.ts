import { describe, expect, it } from 'vitest'
import type { AppHotkeys } from '../../../shared/types'
import { findHotkeyCommand, findHotkeyConflicts, hotkeyFromEvent, isReservedHotkey, matchesHotkey, normalizeHotkey } from './hotkeys'

const keyboard = (key: string, overrides: Partial<KeyboardEvent> = {}) => ({
  key,
  code: key === ' ' ? 'Space' : `Key${key.toUpperCase()}`,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...overrides,
}) as KeyboardEvent

describe('hotkeys', () => {
  it('normalizes aliases and modifier ordering', () => {
    expect(normalizeHotkey('shift + control + z')).toBe('Ctrl + Shift + Z')
    expect(normalizeHotkey('option + r')).toBe('Alt + R')
    expect(normalizeHotkey('esc')).toBe('Escape')
  })

  it('captures keyboard events in canonical form', () => {
    expect(hotkeyFromEvent(keyboard('z', { ctrlKey: true, shiftKey: true }))).toBe('Ctrl + Shift + Z')
    expect(hotkeyFromEvent(keyboard(' ', { code: 'Space' }))).toBe('Space')
  })

  it('matches bindings and resolves commands', () => {
    const hotkeys = { undo: 'Ctrl + Z', redo: 'Ctrl + Shift + Z' } as AppHotkeys
    expect(matchesHotkey(keyboard('z', { ctrlKey: true }), hotkeys.undo)).toBe(true)
    expect(findHotkeyCommand(keyboard('z', { ctrlKey: true, shiftKey: true }), hotkeys)).toBe('redo')
  })

  it('reports duplicate bindings', () => {
    const hotkeys = { undo: 'Ctrl + Z', redo: 'control+z' } as AppHotkeys
    const conflicts = findHotkeyConflicts(hotkeys)
    expect(conflicts.get('undo')).toEqual(['redo'])
    expect(conflicts.get('redo')).toEqual(['undo'])
  })

  it('reserves every app-level reload and developer-tools variation', () => {
    expect(isReservedHotkey('Ctrl + Shift + R')).toBe(true)
    expect(isReservedHotkey('Meta + Alt + R')).toBe(true)
    expect(isReservedHotkey('Ctrl + Shift + I')).toBe(true)
    expect(isReservedHotkey('Alt + R')).toBe(false)
  })
})
