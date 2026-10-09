import { expect,it } from 'vitest'
import { findingSheet,findingSheetChanges } from './findingSheet'
import type { OrganizerSnapshot } from '../../../../shared/qaOrganizer'
const snapshot:OrganizerSnapshot={projectKey:'p',projectName:'P',revision:1,columns:['Section','Remarks'],findings:['a','b'].map((id,index)=>({id,projectKey:'p',projectName:'P',pageUrl:`https://s.test/${id}`,cells:{Section:id,Remarks:'Use **32px**, with `font-size`.'},sources:[],sourceKeys:[],review:'draft',edited:[],createdAt:index,updatedAt:index}))}
const colors={bg:'#fff',text:'#222',accent:'#a00'}
it('preserves row identity and rich text through sorting and a remark edit',()=>{
  const sheet=findingSheet(snapshot,colors,'page');expect(findingSheetChanges(sheet,snapshot)).toEqual([])
  const cell=sheet.celldata!.find(c=>c.r===2&&c.c===2)!;cell.v={v:'Changed, with context.'}
  expect(findingSheetChanges(sheet,snapshot)).toEqual([{id:'b',cells:{Remarks:'Changed, with context.'}}])
})
it('reads text edited by FortuneSheet into inline string runs in non-remark cells',()=>{
  const sheet=findingSheet(snapshot,colors,'page');sheet.celldata!.find(c=>c.r===1&&c.c===1)!.v={v:'',ct:{t:'inlineStr',s:[{v:'Edited section',ff:'Arial'}]}}
  expect(findingSheetChanges(sheet,snapshot)).toEqual([{id:'a',cells:{Section:'Edited section'}}])
})
it('rejects missing/duplicate identities and formulas instead of editing the wrong item',()=>{
  const sheet=findingSheet(snapshot,colors);sheet.celldata!.find(c=>c.r===1&&c.c===3)!.v={v:'a'}
  expect(()=>findingSheetChanges(sheet,snapshot)).toThrow(/identities/)
  const formula=findingSheet(snapshot,colors);formula.celldata!.find(c=>c.r===1&&c.c===2)!.v={v:'x',f:'=1+1'}
  expect(()=>findingSheetChanges(formula,snapshot)).toThrow(/Formula/)
})
