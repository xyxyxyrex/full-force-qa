import { createHash } from 'crypto'
import { mkdtempSync,mkdirSync,writeFileSync,existsSync,readFileSync,rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach,expect,it } from 'vitest'
import { scopedDesignRoot } from './designAccountScope'
const roots:string[]=[];afterEach(()=>{roots.splice(0).forEach(path=>rmSync(path,{recursive:true,force:true}))})
const hash=(owner:string)=>createHash('sha256').update(owner).digest('hex').slice(0,24)
function fixture(owners:Record<string,string[]>){const root=mkdtempSync(join(tmpdir(),'parity-design-owner-'));roots.push(root);const key='shared-project',dir=join(root,'designs',`${key}-${createHash('sha256').update(key).digest('hex').slice(0,8)}`);mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'meta.json'),JSON.stringify({key,slots:{}}));writeFileSync(join(dir,'desktop.png'),'private image');for(const[owner,ids]of Object.entries(owners))writeFileSync(join(root,`projects-${hash(owner)}.json`),JSON.stringify(ids.map(id=>({id}))));return{root,dir}}
it('migrates uniquely owned legacy designs without deleting originals',()=>{const f=fixture({A:['shared-project'],B:['other-project']}),destination=scopedDesignRoot(f.root,'A');expect(readFileSync(join(destination,f.dir.split(/[\\/]/).at(-1)!,'desktop.png'),'utf8')).toBe('private image');expect(existsSync(join(f.dir,'desktop.png'))).toBe(true);expect(scopedDesignRoot(f.root,'B')).not.toBe(destination)})
it('does not claim ambiguous IDs or allow a later account to adopt an earlier owner’s design',()=>{const ambiguous=fixture({A:['shared-project'],B:['shared-project']});const a=scopedDesignRoot(ambiguous.root,'A'),b=scopedDesignRoot(ambiguous.root,'B'),name=ambiguous.dir.split(/[\\/]/).at(-1)!;expect(existsSync(join(a,name))).toBe(false);expect(existsSync(join(b,name))).toBe(false);const f=fixture({A:['shared-project']});scopedDesignRoot(f.root,'A');writeFileSync(join(f.root,`projects-${hash('A')}.json`),'[]');writeFileSync(join(f.root,`projects-${hash('B')}.json`),'[{"id":"shared-project"}]');expect(existsSync(join(scopedDesignRoot(f.root,'B'),name))).toBe(false)})
