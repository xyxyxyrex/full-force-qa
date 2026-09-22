import type { Event, Input, WebContents } from 'electron'

/** Forward only from the Parity shell and its own embedded previews. */
export function forwardPaletteShortcut(contents: WebContents, event: Event, input: Input, shell?: WebContents): boolean {
  if (input.type !== 'keyDown' || !(input.control || input.meta) || !input.shift || input.alt || input.key.toLowerCase() !== 'f') return false
  const owner = (contents as WebContents & { hostWebContents?: WebContents }).hostWebContents || contents
  if (!shell || shell.isDestroyed() || owner.id !== shell.id) return false
  event.preventDefault()
  if (!input.isAutoRepeat) shell.send('palette:open')
  return true
}
