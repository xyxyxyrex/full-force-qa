import React, {useState} from 'react'
import {createRoot} from 'react-dom/client'
import AutomateWorkspace from '../../src/renderer/src/components/AutomateWorkspace'

const data=(window as any).__automationData
const root={id:'frame',name:'Foundation fixture',type:'FRAME',absoluteBoundingBox:{x:0,y:0,width:800,height:3200},children:[
  {id:'target',type:'TEXT',characters:'Stable capture target',absoluteBoundingBox:data.designRect,
    style:{fontSize:20,fontFamily:'Arial',fontWeight:400,lineHeightPx:23,letterSpacing:0,textAlignHorizontal:'LEFT'},
    fills:[{type:'SOLID',color:{r:1,g:1,b:1}}]}
]}
localStorage.setItem('qa_automate_figma_connected','1')
;(window as any).electronAPI={
  figmaTokenStatus:async()=>({apiConfigured:true}),
  onFigmaAuthChanged:()=>()=>{},
  listFigmaFrames:async()=>({success:true,fileName:'Local QA fixture',frames:[{id:'frame',name:'Foundation fixture',pageName:'QA',width:800,height:3200,type:'FRAME'}]}),
  getFigmaFrame:async()=>({success:true,node:root,imageDataUrl:data.design}),
  captureAutomatePage:async()=>data.capture,
  compareVisuals:async()=>data.comparison,
  cancelVisualComparison:async()=>({success:true}),
}
function Fixture(){
  const [state,setState]=useState({triage:{},runsByFrame:{}})
  return <AutomateWorkspace sourceUrl="data:text/html,<p>Capture placeholder</p>" figmaUrl="https://www.figma.com/design/fixture" projectId="local-smoke"
    automateState={state} onAutomateStateChange={setState} onCreateAnnotation={spec=>{(window as any).__pinned=spec;return 'pin'}} />
}
createRoot(document.getElementById('root')!).render(<Fixture/>)
