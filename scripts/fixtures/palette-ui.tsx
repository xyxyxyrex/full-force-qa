import { createRoot } from 'react-dom/client'
import CommandPalette from '../../src/renderer/src/components/CommandPalette'
import { usePaletteProvider } from '../../src/renderer/src/palette/registry'
import { pageSearch, pageSearchExpression } from '../../src/renderer/src/palette/pageSearch'
import '../../src/renderer/src/theme/themes.css'

function Fixture() {
  usePaletteProvider({ id: 'fixture', label: 'Fixture', commands: () => [
    { id: 'run', title: 'Test command', group: 'Commands', run: () => { (window as any).ran = true; (window as any).ranWithoutPalette = !document.querySelector('.command-palette-overlay') } },
    { id: 'disabled', title: 'Disabled command', group: 'Commands', disabled: 'Select an element first', run: () => { throw new Error('Should not run') } },
  ], search: async query => {
    await new Promise(resolve => setTimeout(resolve, query === 'slow' ? 450 : 10))
    return { items: [{ id: query, title: `Result ${query}`, group: 'Page', run() {} }] }
  } })
  Object.assign(window, { pageSearch, pageSearchExpression })
  return <><div className="app-workspace-host"><button id="opener" onClick={() => window.dispatchEvent(new Event('parity:open-palette'))}>Open palette</button><button title="Current view operation" onClick={() => { (window as any).contextRan = true }}>Operation</button></div><CommandPalette scopeKey="fixture" /></>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
