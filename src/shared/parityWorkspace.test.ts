import { describe,expect,it } from 'vitest'
import { folderBreadcrumb, parseWorkspaceLink, planWorkspaceChanges, projectRecord, selectWorkspaceRecords, workspaceDateRange, workspaceRecordLink, type WorkspaceSnapshot } from './parityWorkspace'
import { parseQaCommand, tokenizeQaCommand } from './qaCommands'
const snapshot=():WorkspaceSnapshot=>({revision:4,folders:[{id:'a',name:'Client',createdAt:1},{id:'b',name:'Child',parentId:'a',createdAt:1}],projects:[{id:'p',name:'Home page',stagingUrl:'https://example.test/a?b=1#c',adminUrl:'https://secret:password@example.test/wp-admin',createdAt:1,lastOpenedAt:3,folderId:'a'}]})
describe('Parity workspace planning',()=>{
  it('preserves URL queries, case, fragments, HTTP/HTTPS distinction, and destination-only duplicates',()=>{
    const value=snapshot(),url='https://example.test/Case?q=one%2Ctwo#Anchor'
    const result=planWorkspaceChanges(value,[{type:'create-project',id:'p2',url,folderId:'b'},{type:'create-project',id:'p3',url,folderId:'b'},{type:'create-project',id:'p4',url:url.replace('https:','http:'),folderId:'b'}],8)
    expect(result.projects.map(p=>p.stagingUrl)).toEqual([url,url.replace('https:','http:')]);expect(result.changes[1].after).toContain('Skipped');expect(value.projects).toHaveLength(1)
  })
  it('supports intentional duplicates and keeps layout-independent stable IDs',()=>{const value=snapshot();const r=planWorkspaceChanges(value,[{type:'create-project',id:'stable',url:value.projects[0].stagingUrl,folderId:'a',keepDuplicate:true}],8);expect(r.projects[0].id).toBe('stable');expect(r.projects[0].lastOpenedAt).toBe(0)})
  it('creates a folder and its projects in one plan',()=>{const r=planWorkspaceChanges(snapshot(),[{type:'create-folder',id:'new',name:'Launch',parentId:'a'},{type:'create-project',id:'new-page',url:'https://example.test/launch',folderId:'new'}],8);expect(r.projects[0].folderId).toBe('new');expect(folderBreadcrumb(r.snapshot.folders,'new')).toBe('Home / Client / Launch')})
  it('reparents projects and subfolders when deleting a folder',()=>{const r=planWorkspaceChanges(snapshot(),[{type:'delete-folder',id:'a'}],8);expect(r.snapshot.folders[0].parentId).toBeUndefined();expect(r.projects[0].folderId).toBeUndefined();expect(r.changes[0].after).toContain('1 projects and 1 subfolders to Home')})
  it('rejects cycles, missing destinations, arbitrary operations and embedded credentials',()=>{
    expect(()=>planWorkspaceChanges(snapshot(),[{type:'move',kind:'folder',id:'a',folderId:'b'}],8)).toThrow('descendants')
    expect(()=>planWorkspaceChanges(snapshot(),[{type:'move',kind:'project',id:'p',folderId:'missing'}],8)).toThrow('no longer exists')
    expect(()=>planWorkspaceChanges(snapshot(),[{type:'create-project',id:'new',url:'https://name:secret@example.test'}],8)).toThrow('credentials')
    expect(()=>planWorkspaceChanges(snapshot(),[{type:'permanent-delete',id:'p'} as any],8)).toThrow('not supported')
  })
  it('trashes and restores without removing project content',()=>{const value=snapshot();value.projects[0].workspaceData={annotations:[{id:'annotation'}]} as any;const trash=planWorkspaceChanges(value,[{type:'trash',id:'p'}],8);expect(trash.projects[0].deletedAt).toBe(8);const restored=planWorkspaceChanges(trash.snapshot,[{type:'restore',id:'p'}],9);expect(restored.projects[0].deletedAt).toBeUndefined();expect(restored.projects[0].workspaceData).toEqual(value.projects[0].workspaceData)})
  it('projects source metadata excludes login/admin settings and has valid owned navigation references',()=>{const p=projectRecord(snapshot().projects[0],snapshot().folders,'cached');expect(JSON.stringify(p)).not.toMatch(/adminUrl|password/);expect(parseWorkspaceLink(workspaceRecordLink(p))).toMatchObject({kind:'project',id:'p'});expect(parseWorkspaceLink('file:///private')).toBeNull();expect(parseWorkspaceLink('parity://record/project/p/extra')).toBeNull()})
})
describe('dates, queries, commands',()=>{
  it('uses local calendar boundaries and labels the timezone',()=>{const r=workspaceDateRange('10/09/26');expect(new Date(r.from).getFullYear()).toBe(2026);expect(new Date(r.from).getMonth()).toBe(9);expect(new Date(r.from).getDate()).toBe(9);expect(new Date(r.to).getDate()).toBe(10);expect(r.dateLabel).toContain('2026-10-09');expect(()=>workspaceDateRange('02/30/26')).toThrow();expect(()=>workspaceDateRange('2026-10-09')).toThrow()})
  it('does not substitute creation dates for missing capture dates',()=>{const r=selectWorkspaceRecords([projectRecord(snapshot().projects[0],snapshot().folders,'cached')],{dateField:'captured',from:0,to:20});expect(r.records).toHaveLength(0)})
  it('paginates and omits trash unless requested',()=>{const records=Array.from({length:6},(_,i)=>({...projectRecord(snapshot().projects[0],snapshot().folders,'cached'),id:`p${i}`,createdAt:i,inTrash:i===5}));const r=selectWorkspaceRecords(records,{limit:2,offset:2});expect(r.records.map(r=>r.id)).toEqual(['p2','p1']);expect(r.nextOffset).toBe(4)})
  it('parses quoted names and leaves encoded URLs intact',()=>{expect(parseQaCommand('/move project "Client home" "Home / Client"')?.args).toEqual(['project','Client home','Home / Client']);expect(tokenizeQaCommand('/create project https://example.test/Case?q=a%2Cb#X')).toEqual(['/create','project','https://example.test/Case?q=a%2Cb#X']);expect(()=>parseQaCommand('/rename folder "unfinished')).toThrow('quoted')})
})
