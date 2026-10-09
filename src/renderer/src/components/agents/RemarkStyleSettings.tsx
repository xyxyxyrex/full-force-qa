import { useEffect, useState } from 'react'
import { DEFAULT_REMARK_STYLE, normalizeRemarkStyle, remarkExample, remarkLimit, type RemarkStyle } from '../../../../shared/remarkStyle'
import RichText from '../qaChat/RichText'
export default function RemarkStyleSettings({ value, save }: { value?: RemarkStyle; save: (style: RemarkStyle) => Promise<void> }) {
  const [draft, setDraft] = useState(()=>normalizeRemarkStyle(value)); const [busy,setBusy]=useState(false); const [error,setError]=useState(''); const [saved,setSaved]=useState(false)
  useEffect(()=>{ setDraft(normalizeRemarkStyle(value)) },[value])
  const change = (patch: Partial<RemarkStyle>)=>{setDraft(previous=>({...previous,...patch}));setSaved(false)}
  const dirty=JSON.stringify(draft)!==JSON.stringify(normalizeRemarkStyle(value))
  return <section className="agents-group agents-remark-style" aria-label="Remark style"><h4>Remark style</h4><p className="agents-muted">Choose how the agent writes QA items. Applies to new audits and chat requests; existing remarks stay as written.</p>
    <label className="agents-field"><span>Tone</span><select value={draft.tone} onChange={e=>change({tone:e.target.value as RemarkStyle['tone']})}><option value="direct">Direct</option><option value="professional">Professional</option><option value="friendly">Friendly</option></select></label>
    {(['technicality','detail'] as const).map(key=><label className="agents-style-slider" key={key}><span>{key==='technicality'?'Technicality':'Detail'}<b>{(key==='technicality'?['Plain language','Balanced','Technical']:['Brief','Standard','Detailed'])[draft[key]]}</b></span><input aria-label={key==='technicality'?'Remark technicality':'Remark detail'} type="range" min="0" max="2" step="1" value={draft[key]} onChange={e=>change({[key]:Number(e.target.value)})}/><small>{key==='technicality'?'Plain language':'Brief'}<span>{key==='technicality'?'Technical':'Detailed'}</span></small></label>)}
    <label className="agents-switch"><input type="checkbox" checked={draft.formatting} onChange={e=>change({formatting:e.target.checked})}/><span>Light formatting <small>Bold key details and inline code</small></span></label>
    <div className="agents-style-preview"><small>LIVE EXAMPLE · {remarkLimit(draft)} character limit</small><RichText text={remarkExample(draft)}/></div>
    {error&&<p className="agents-warn" role="alert">{error}</p>}<div className="agents-row"><button type="button" className="agents-button primary" disabled={!dirty||busy} onClick={()=>{setBusy(true);setError('');void save(draft).then(()=>setSaved(true)).catch(cause=>setError(cause.message||'Could not save the remark style.')).finally(()=>setBusy(false))}}>{busy?'Saving…':saved&&!dirty?'Saved':'Save style'}</button><button type="button" className="agents-link" onClick={()=>{setDraft({...DEFAULT_REMARK_STYLE});setSaved(false)}}>Reset defaults</button></div>
  </section>
}
