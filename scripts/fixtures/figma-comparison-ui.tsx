import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import ComparisonWipeHandle from '../../src/renderer/src/components/ComparisonWipeHandle'
import ComparisonModeIsland from '../../src/renderer/src/components/ComparisonModeIsland'

function Fixture() {
  const [reveal, setReveal] = useState(50)
  const [opacity, setOpacity] = useState(50)
  const [mode, setMode] = useState<'overlay' | 'side-by-side' | 'diff'>('side-by-side')
  const [hasImage, setHasImage] = useState(false)
  return <>
    <button id="attach" onClick={() => setHasImage(true)}>Attach PNG</button>
    {mode === 'side-by-side' && <div id="figma-card" style={{ position: 'absolute', left: 180, top: 150, width: 400, height: 300, background: '#342c43', border: '1px solid #76618b' }}>
      <ComparisonModeIsland mode={mode} hasImage={hasImage} onModeChange={setMode} />
    </div>}
    <div id="preview" style={{ position: 'relative', width: 400, height: 300, margin: '160px 0 0 600px', background: '#304c68' }}>
      {mode !== 'side-by-side' && <ComparisonModeIsland mode={mode} hasImage={hasImage} onModeChange={setMode} />}
      <button id="underlying" style={{ position: 'absolute', right: 20, top: 100 }}>Page button</button>
      {mode === 'overlay' && <ComparisonWipeHandle reveal={reveal} opacity={opacity} width={400} onReveal={setReveal} onOpacity={setOpacity} />}
    </div>
  </>
}

createRoot(document.getElementById('root')!).render(<Fixture />)
