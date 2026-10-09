import type { Cell, Sheet } from '@fortune-sheet/core'
import type { FindingUpdate, OrganizerSnapshot } from '../../../../shared/qaOrganizer'
import { remarkSegments, plainRemark } from '../../../../shared/remarkStyle'
export const AI_SHEET_ID = 'parity-ai-findings'
export const REVIEW_LABELS = { draft:'Draft', accepted:'Accepted', dismissed:'Dismissed' } as const
export const sheetColumns = (snapshot: OrganizerSnapshot) => ['Review', ...snapshot.columns, 'Finding ID']
export function findingSheet(snapshot: OrganizerSnapshot, colors: { bg:string; text:string; accent:string }, sort='newest'): Sheet {
  const columns=sheetColumns(snapshot);const items=snapshot.findings.filter(f=>!f.mergedInto).sort((a,b)=>sort==='page'?a.pageUrl.localeCompare(b.pageUrl):sort==='section'?(a.cells.Section||'').localeCompare(b.cells.Section||''):b.createdAt-a.createdAt)
  const celldata: NonNullable<Sheet['celldata']>=columns.map((column,c)=>({r:0,c,v:{v:column,m:column,bl:1,bg:colors.bg,fc:colors.text,tb:'2',ff:'Arial'}}))
  for(const [index,item] of items.entries()) columns.forEach((column,c)=>{
    const raw=c===0?REVIEW_LABELS[item.review]:c===columns.length-1?item.id:item.cells[column]||''
    const text=plainRemark(raw);const segments=remarkSegments(raw)
    celldata.push({r:index+1,c,v:{v:text,m:text,fc:colors.text,bg:colors.bg,tb:'2',vt:0,ff:'Arial',ct:segments.some(s=>s.bold||s.code)?{t:'inlineStr',s:segments.map(s=>({v:s.text,bl:s.bold?1:0,ff:s.code?'monospace':'Arial',fc:colors.text}))}:{t:'s'}}})
  })
  return {id:AI_SHEET_ID,name:'AI Findings',order:0,status:1,color:colors.accent,column:columns.length,row:Math.max(50,items.length+10),celldata,defaultRowHeight:56,
    luckysheet_select_save:[{row:[0,0],column:[0,0],row_focus:0,column_focus:0}],
    config:{colhidden:{[columns.length-1]:0},colReadOnly:{[columns.length-1]:1},rowReadOnly:{0:1},columnlen:Object.fromEntries(columns.map((column,c)=>[c,/remarks|description|issue/i.test(column)?400:/page|screenshot/i.test(column)?220:150])),rowlen:{0:32}}}
}
function cellsOf(sheet: Sheet) {
  if(sheet.data) return sheet.data.map(row=>row||[])
  const rows: Array<Array<Cell|null>>=[]
  for(const entry of sheet.celldata||[]){ rows[entry.r] ||= []; rows[entry.r][entry.c]=entry.v }
  return rows
}
function cellText(cell: Cell|null|undefined, rich=false) {
  if(cell?.f) throw new Error('Formula cells are not supported in managed findings. Enter text instead.')
  if(cell?.ct?.t==='inlineStr'&&Array.isArray(cell.ct.s))return cell.ct.s.map((s:any)=>rich&&s.bl?`**${s.v||''}**`:rich&&s.ff==='monospace'?`\`${s.v||''}\``:s.v||'').join('')
  return String(cell?.v??cell?.m??'')
}
/** Identity travels with the complete row. Partial sorts or ID edits are rejected before saving. */
export function findingSheetChanges(sheet: Sheet, snapshot: OrganizerSnapshot): FindingUpdate[] {
  const columns=sheetColumns(snapshot); const active=snapshot.findings.filter(f=>!f.mergedInto); const seen=new Set<string>();const changes:FindingUpdate[]=[]
  for(const row of cellsOf(sheet).slice(1)) {
    const id=cellText(row[columns.length-1]); if(!id){if(row.some(cell=>cellText(cell)))throw new Error('Add or remove findings in the Findings tab; managed rows keep their identities.');continue}
    const item=active.find(f=>f.id===id);if(!item||seen.has(id))throw new Error('The managed row identities changed. Refresh the tracker before editing.');seen.add(id)
    const review=Object.entries(REVIEW_LABELS).find(([,label])=>label===cellText(row[0]))?.[0] as FindingUpdate['review']
    if(!review)throw new Error('Choose Draft, Accepted, or Dismissed in the Review cell.')
    const cells:Record<string,string>={}
    columns.slice(1,-1).forEach((column,index)=>{const text=cellText(row[index+1],/^remarks$/i.test(column));if(text!==(item.cells[column]||''))cells[column]=text})
    if(Object.keys(cells).length||review!==item.review)changes.push({id,cells,...(review!==item.review?{review}:{})})
  }
  if(seen.size!==active.length)throw new Error('Managed findings cannot be deleted in the grid. Use Dismiss in Findings.')
  return changes
}
