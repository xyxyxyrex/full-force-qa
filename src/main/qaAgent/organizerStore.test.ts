import { afterEach,expect,it } from 'vitest'
import { mkdtempSync,rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createOrganizerStore } from './organizerStore'
import { STANDARD_TRACKER } from '../../shared/trackerFormat'
const dirs:string[]=[]
afterEach(()=>dirs.splice(0).forEach(dir=>rmSync(dir,{recursive:true,force:true})))
function fixture(){const dir=mkdtempSync(join(tmpdir(),'qa-organizer-'));dirs.push(dir);return {dir,store:createOrganizerStore(dir,()=>123),meta:{id:'run-1',projectKey:'p',projectName:'Project',pageUrl:'https://site.test/a',createdAt:1,touchedAt:1}}}
const row={cells:{Section:'Hero',Remarks:'Increase the heading size to **32px**.',Display:'Desktop'}}
it('saves stable drafts, scopes accounts/projects and retains immutable evidence on reopen',()=>{
  const {dir,store,meta}=fixture();const saved=store.save('owner',meta,'desktop',[row],'visual',STANDARD_TRACKER,[{data:Buffer.from('picture'),caption:'Heading'}])
  expect(store.save('owner',meta,'desktop',[row],'visual',STANDARD_TRACKER).rows[0].findingId).toBe(saved.rows[0].findingId)
  expect(store.read('other','p','Project',STANDARD_TRACKER).findings).toHaveLength(0)
  expect(store.read('owner','other','Other',STANDARD_TRACKER).findings).toHaveLength(0)
  expect(createOrganizerStore(dir).picture('owner','p',saved.rows[0].findingId!,STANDARD_TRACKER)?.data.toString()).toBe('picture')
})
it('protects human wording, priority and review decisions from repeated agent saves and merges',()=>{
  const {store,meta}=fixture();const saved=store.save('o',meta,'desktop',[row],'visual',STANDARD_TRACKER)
  const id=saved.rows[0].findingId!;store.update('o','p','Project',saved.snapshot.revision,[{id,cells:{Remarks:'My human wording','Priority (QA/PM)':'High'},review:'accepted'}],STANDARD_TRACKER)
  store.save('o',meta,'desktop',[{...row,findingId:id,cells:{...row.cells,Remarks:'Agent rewrite'}}],'visual',STANDARD_TRACKER)
  store.reconcile('o',[{meta,row:{...row,findingId:id,sourceFindingIds:[id]}}],STANDARD_TRACKER)
  expect(store.read('o','p','Project',STANDARD_TRACKER).findings[0]).toMatchObject({review:'accepted',cells:{Remarks:'My human wording','Priority (QA/PM)':'High'}})
})
it('consolidates source breakpoints idempotently and rejects foreign source IDs',()=>{
  const {store,meta}=fixture();const a=store.save('o',meta,'desktop',[row],'visual',STANDARD_TRACKER,[{data:Buffer.from('desktop'),caption:'Desktop'}]).rows[0];const b=store.save('o',meta,'mobile',[{...row,cells:{...row.cells,Display:'Mobile'}}],'visual',STANDARD_TRACKER,[{data:Buffer.from('mobile'),caption:'Mobile'}]).rows[0]
  const merged={...a,sourceFindingIds:[a.findingId!,b.findingId!],cells:{...row.cells,Display:'Desktop and Mobile'}}
  store.reconcile('o',[{meta,row:merged}],STANDARD_TRACKER);store.reconcile('o',[{meta,row:merged}],STANDARD_TRACKER)
  const active=store.read('o','p','Project',STANDARD_TRACKER).findings.filter(f=>!f.mergedInto)
  expect(active).toHaveLength(1);expect(active[0].sources).toHaveLength(2)
  expect(active[0].evidenceSet).toHaveLength(2);expect(store.picture('o','p',active[0].id,STANDARD_TRACKER,1)?.data.toString()).toBe('mobile')
  expect(()=>store.reconcile('o',[{meta:{...meta,projectKey:'other'},row:merged}],STANDARD_TRACKER)).toThrow(/another project/)
})
it('rejects stale and invalid edits atomically and supports bulk review without tracker-status confusion',()=>{
  const {store,meta}=fixture();const saved=store.save('o',meta,'desktop',[row],'visual',STANDARD_TRACKER);const id=saved.rows[0].findingId!
  expect(()=>store.update('o','p','Project',0,[{id,review:'accepted'}],STANDARD_TRACKER)).toThrow(/changed/)
  expect(()=>store.update('o','p','Project',saved.snapshot.revision,[{id,review:'accepted'},{id:'missing'}],STANDARD_TRACKER)).toThrow(/no longer/)
  expect(store.read('o','p','Project',STANDARD_TRACKER).findings[0].review).toBe('draft')
  const next=store.update('o','p','Project',saved.snapshot.revision,[{id,review:'dismissed',cells:{Status:'IN PROGRESS (DEV)'}}],STANDARD_TRACKER)
  expect(next.findings[0]).toMatchObject({review:'dismissed',cells:{Status:'IN PROGRESS (DEV)'}})
})
