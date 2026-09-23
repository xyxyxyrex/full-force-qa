import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import BrowserComparisonPanel from '../../src/renderer/src/components/BrowserComparisonPanel'

const page = (accent: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="500" height="1500"><rect width="500" height="1500" fill="#fff"/><rect width="500" height="130" fill="#27212c"/><text x="30" y="70" font-size="28" fill="white">Browser fixture</text><rect x="30" y="175" width="440" height="165" fill="${accent}"/><text x="30" y="420" font-size="24">First section</text><rect x="30" y="480" width="440" height="270" fill="#eee"/><text x="30" y="845" font-size="24">Below the fold</text><rect x="30" y="920" width="440" height="270" fill="#ddd"/><text x="30" y="1380" font-size="24">Footer</text></svg>`)}`
const chromiumImage = page('#3754a8')
const firefoxImage = page('#a83754')
const record = { id: 'a0000000-0000-0000-0000-000000000001', projectId: 'test', engine: 'firefox', browserVersion: 'fixture', url: 'https://example.test/', finalUrl: 'https://example.test/', capturedAt: new Date().toISOString(), width: 500, height: 300, fullPage: true, imageHeight: 1500, chromiumImageHeight: 1500, pinnedHeaderHeight: 50, scrollY: 0, actualScrollY: 0, chromiumEdited: false, warning: 'The browser could not reach the Chromium scroll position.', annotations: [] }
let saved = [record]
const image = { record, image: firefoxImage, chromiumImage }
Object.assign(window, { electronAPI: {
  comparisonStatus: async () => ({ firefox: true, webkit: true }),
  comparisonList: async () => saved,
  comparisonCapture: async () => { saved = [record]; return image },
  comparisonLoad: async () => image,
  comparisonDelete: async (_projectId: string, id: string) => { saved = saved.filter(item => item.id !== id) },
  comparisonSaveAnnotations: async (_projectId: string, _id: string, annotations: any[]) => ({ ...record, annotations }),
  onComparisonProgress: () => () => {}, onAccountChanged: () => () => {},
} })

function Fixture() {
  const [scrollY, setScrollY] = useState(0)
  return <div id="canvas"><div className="fixture-card"><header>Live Site · 500 × 300</header><div className="fixture-live-header" aria-hidden="true" /><div id="live" onScroll={event => setScrollY(event.currentTarget.scrollTop)}><img src={chromiumImage} /></div></div><div className="fixture-card" id="comparison"><BrowserComparisonPanel engine="firefox" projectId="test" captureChromium={async () => ({ url: 'https://example.test/', width: 500, height: 300, scrollY, chromiumImage })} getPageUrl={() => 'https://example.test/'} scrollY={scrollY} onScroll={top => { const element = document.getElementById('live')!; element.scrollTop = top; setScrollY(top) }} onClose={() => {}} /></div></div>
}

createRoot(document.getElementById('root')!).render(<Fixture />)
