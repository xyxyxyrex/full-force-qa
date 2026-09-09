import { useEffect, useRef, useState } from 'react'
import type { AutomationFinding, PixelComparison } from '../../../shared/automation'

/** Display-only zoom. Every source shares one origin and scale, including Slider. */
export function ComparisonView({designImage,liveImage,result,finding}: {
  designImage: string; liveImage: string; result: PixelComparison; finding?: AutomationFinding
}) {
  const [view,setView] = useState<'design'|'live'|'diff'|'slider'>('diff')
  const [slider,setSlider] = useState(50)
  const [availableWidth,setAvailableWidth] = useState(600)
  const [native,setNative] = useState(false)
  const [imageError,setImageError] = useState('')
  const stage = useRef<HTMLDivElement>(null)
  const width = Math.max(result.design.width,result.live.width)
  const height = Math.max(result.design.height,result.live.height)
  const scale = native ? 1 : Math.min(1, Math.max(1,availableWidth-24)/width)
  useEffect(()=>{
    const element = stage.current
    if (!element) return
    const observer = new ResizeObserver(entries=>setAvailableWidth(entries[0].contentRect.width))
    observer.observe(element)
    return ()=>observer.disconnect()
  },[])
  useEffect(()=>{setImageError('')},[result])
  useEffect(()=>{
    const rect = finding?.comparison?.[view==='design'?'design':'live']?.rect || finding?.comparison?.design?.rect
    if (rect && stage.current) stage.current.scrollTo({top:Math.max(0,rect.y*scale-60),left:Math.max(0,rect.x*scale-40),behavior:'auto'})
  },[finding,view,scale])
  const img=(src:string,size:{width:number;height:number},label:string)=><img
    src={src} alt={label} draggable={false} onError={()=>setImageError('Preview could not be decoded. Comparison data remains available.')}
    style={{position:'absolute',left:0,top:0,width:size.width*scale,height:size.height*scale,maxWidth:'none'}} />
  const rect=finding?.comparison?.[view==='design'?'design':'live']?.rect
  return <section className="automate-visual-card">
    <div className="automate-card-head"><h3>Comparison</h3>
      <div className="automate-view-switch">{(['design','live','diff','slider'] as const).map(mode=>
        <button key={mode} aria-pressed={view===mode} className={view===mode?'active':''} onClick={()=>setView(mode)}>{mode[0].toUpperCase()+mode.slice(1)}</button>)}</div>
      <button className="automate-secondary" aria-pressed={native} onClick={()=>setNative(!native)}>{native?'1:1':'Fit width'}</button>
    </div>
    {view==='slider'&&<label className="automate-slider">Design / Live<input aria-label="Design and Live reveal" type="range" min="0" max="100" value={slider} onChange={e=>setSlider(Number(e.target.value))} /></label>}
    {imageError && <p role="alert">{imageError}</p>}
    <div className="automate-native-stage" ref={stage}>
      <div className="automate-native-canvas" style={{width:width*scale,height:height*scale}}>
        {view==='design'&&img(designImage,result.design,'Design')}
        {(view==='live'||view==='slider')&&img(liveImage,result.live,'Live')}
        {view==='diff'&&img(result.diffDataUrl,result.overlap,'Difference mask: white pixels changed, black pixels unchanged')}
        {view==='slider'&&<div style={{position:'absolute',inset:0,clipPath:`inset(0 ${100-slider}% 0 0)`}}>{img(designImage,result.design,'Design reveal')}</div>}
        {view==='slider'&&<div className="automate-slider-line" style={{left:`${slider}%`}} />}
        {rect&&<div className="automate-region-outline" style={{left:rect.x*scale,top:rect.y*scale,width:rect.width*scale,height:rect.height*scale}} />}
      </div>
    </div>
    <p className="automate-preview-caption">{finding?.title || 'Full-page review'} · {Math.round(scale*100)}% display zoom. Hatched space is outside the displayed source, not a match.</p>
  </section>
}
