import {describe,expect,it} from 'vitest'
import {compareStyles} from './styles'
import type {DomNode} from '../utils/visualCompare'
const node = (styles:Record<string,string>):DomNode => ({
  tag:'p',text:'Example',role:'',src:'',context:'',path:'p',
  rect:{x:0,y:0,width:200,height:20},styles
})
describe('measured typography evidence',()=>{
  it('keeps numeric differences separate from match quality',()=>{
    const token=compareStyles({style:{fontSize:20}},node({fontSize:'28px'}))[0]
    expect(token).toMatchObject({name:'font-size',passed:false,difference:8})
  })
  it('does not verify missing computed properties or an inferred line height',()=>{
    const tokens=compareStyles({style:{fontSize:20,fontWeight:400,lineHeightPx:28}},node({lineHeight:'normal'}))
    expect(tokens).toHaveLength(3)
    expect(tokens.every(t=>t.unresolved && !t.passed)).toBe(true)
  })
  it('does not claim the fallback list proves the expected font is active',()=>{
    const token=compareStyles({style:{fontFamily:'Inter'}},node({fontFamily:'Arial, Inter'}))[0]
    expect(token.passed).toBe(false)
  })
  it('resolves logical start alignment only with known writing direction',()=>{
    expect(compareStyles({style:{textAlignHorizontal:'LEFT'}},node({textAlign:'start',direction:'ltr'}))[0].passed).toBe(true)
  })
  it('does not compare a text fill to a DOM background',()=>{
    const tokens=compareStyles({fills:[{type:'SOLID',color:{r:1,g:0,b:0}}]},node({color:'rgb(255, 0, 0)',backgroundColor:'rgb(0, 0, 255)'}))
    expect(tokens).toHaveLength(1)
    expect(tokens[0]).toMatchObject({name:'color',passed:true})
  })
  it('keeps translucent paint unresolved without its background context',()=>{
    const token=compareStyles({opacity:0.5,fills:[{type:'SOLID',color:{r:1,g:0,b:0}}]},node({color:'rgb(255, 0, 0)'}))[0]
    expect(token).toMatchObject({name:'color',passed:false,unresolved:true})
  })
})
