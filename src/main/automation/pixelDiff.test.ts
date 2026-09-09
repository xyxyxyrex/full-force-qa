import { describe, expect, it } from 'vitest'
import pixelmatch from 'pixelmatch'
import { PNG } from 'pngjs'
import { comparePixels, type Raster } from './pixelDiff'
import { clusterDiff } from './clusterDiff'
import { decodeScreenshot, encodeMask } from './imageLoader'
import { visualFindings } from '../../shared/automationFindings'
import { captureViewport, assertNativeSize, assertStablePage } from './captureNormalization'

function raster(width=80,height=100): Raster {
  return {width,height,data:new Uint8Array(width*height*4).fill(255)}
}
function box(image:Raster,x:number,y:number,width:number,height:number,value=0) {
  for(let row=y;row<y+height;row++) for(let col=x;col<x+width;col++) {
    const offset=(row*image.width+col)*4
    image.data[offset]=value;image.data[offset+1]=value;image.data[offset+2]=value
  }
  return image
}
describe('native Pixelmatch comparison',()=>{
  it('returns zero differences and preserves dimensions for identical screenshots',()=>{
    const image=box(raster(),10,10,30,20)
    const result=comparePixels(image,image)
    expect(result.changedPixels).toBe(0)
    expect(result.regions).toEqual([])
    expect(result.design).toEqual({width:80,height:100})
    expect(result.overlap).toEqual(result.design)
  })
  it('compares only overlapping pixels and explicitly reports both dimension changes',()=>{
    const result=comparePixels(raster(80,100),raster(90,120))
    expect(result.changedPixels).toBe(0)
    expect(result.overlap).toEqual({width:80,height:100})
    expect(result.dimensions).toEqual({widthDelta:10,heightDelta:20})
    expect(result.excludedPixels).toEqual({design:0,live:2800})
    const findings=visualFindings({...result,diffDataUrl:''})
    expect(findings.filter(f=>f.state==='fail').map(f=>f.title)).toEqual(['Page width','Page height'])
  })
  it('preserves an isolated one-pixel defect',()=>{
    const result=comparePixels(raster(),box(raster(),40,40,1,1))
    expect(result.changedPixels).toBe(1)
    expect(result.regions).toEqual([{x:40,y:40,width:1,height:1,pixels:1,percent:100}])
  })
  it.each([1,4,8,16])('does not normalize a %ipx horizontal displacement',shift=>{
    const design=box(raster(),10,10,30,20)
    const live=box(raster(),10+shift,10,30,20)
    const result=comparePixels(design,live)
    expect(result.changedPixels).toBe(shift*20*2)
    expect(result.regions).toHaveLength(2)
    expect(result.regions[0]).toMatchObject({x:10,y:10,width:shift,height:20})
    expect(result.regions[1]).toMatchObject({x:40,y:10,width:shift,height:20})
    expect(result.design).toEqual(result.live)
  })
  it.each([4,8,16])('does not normalize a %ipx vertical displacement',shift=>{
    const result=comparePixels(box(raster(),10,10,30,20),box(raster(),10,10+shift,30,20))
    expect(result.changedPixels).toBe(shift*30*2)
    expect(result.regions[0].y).toBe(10)
    expect(result.regions[1].y).toBe(30)
  })
  it.each([16,-16])('retains downstream shifts and the height delta after vertical content changes (%i)',delta=>{
    const design=box(box(raster(80,160),10,10,30,15),10,80,30,20)
    const live=box(box(raster(80,160+delta),10,10,30,15),10,80+delta,30,20)
    const result=comparePixels(design,live)
    expect(result.dimensions.heightDelta).toBe(delta)
    expect(result.changedPixels).toBe(16*30*2)
    expect(result.regions.some(r=>r.y===Math.min(80,80+delta))).toBe(true)
  })
  it('does not stretch content when page width or height changes',()=>{
    const a=box(raster(80,100),10,10,20,20)
    const b=box(raster(160,200),10,10,20,20)
    expect(comparePixels(a,b).changedPixels).toBe(0)
  })
  it('preserves long-page defects beyond the old 1800px fallback limit',()=>{
    const a=box(raster(1920,6000),600,5000,60,40)
    const b=box(raster(1920,6000),608,5000,60,40)
    const result=comparePixels(a,b)
    expect(result.overlap).toEqual({width:1920,height:6000})
    expect(result.changedPixels).toBe(640)
    expect(result.regions[0]).toMatchObject({x:600,y:5000,width:8,height:40})
  })
  it('is tile-size independent, including AA decisions at tile boundaries',()=>{
    const a=raster(24,80),b=raster(24,80)
    for(let y=0;y<80;y++) {
      box(a,4,y,8,1);box(b,4,y,8,1)
      box(a,12,y,1,1,110);box(b,12,y,1,1,160)
    }
    const small=comparePixels(a,b,{pixelThreshold:0.1,includeAA:false},7)
    const whole=comparePixels(a,b,{pixelThreshold:0.1,includeAA:false},100)
    expect(small.mask).toEqual(whole.mask)
    expect(small.regions).toEqual(whole.regions)
    expect(small.changedPixels).toBe(0)
    expect(comparePixels(a,b,{pixelThreshold:0.1,includeAA:true}).changedPixels).toBeGreaterThan(0)
    const output=new Uint8Array(a.data.length)
    expect(pixelmatch(a.data,b.data,output,24,80,{threshold:0.1,includeAA:false})).toBe(small.changedPixels)
  })
  it('labels un-attributed differences as visual evidence, never a CSS diagnosis',()=>{
    const result=comparePixels(raster(),box(raster(),10,10,20,20))
    const f=visualFindings({...result,diffDataUrl:''}).find(f=>f.state==='visual')!
    expect(f.title).toBe('Visual difference detected')
    expect(f.evidenceStrength).toBe('visual')
    expect(f.difference?.pixels).toBe(400)
    expect(f).not.toHaveProperty('confidence')
  })
  it('rejects invalid inputs rather than returning a synthetic pass',()=>{
    expect(()=>comparePixels({...raster(),width:0},raster())).toThrow()
    expect(()=>comparePixels(raster(),raster(),{pixelThreshold:NaN,includeAA:false})).toThrow()
    expect(()=>comparePixels(raster(),raster(),undefined,0)).toThrow()
  })
})
describe('deterministic mask regions',()=>{
  it('uses exact 8-connected components without swallowing tiny differences',()=>{
    const mask=new Uint8Array(8*8)
    mask[1*8+1]=1;mask[2*8+2]=1;mask[6*8+7]=1
    const copy=mask.slice()
    const expected=[{x:1,y:1,width:2,height:2,pixels:2,percent:50},{x:7,y:6,width:1,height:1,pixels:1,percent:100}]
    expect(clusterDiff(mask,8,8)).toEqual(expected)
    expect(mask).toEqual(copy)
    expect(clusterDiff(mask,8,8)).toEqual(expected)
  })
  it('retains more than the legacy 120-region cap',()=>{
    const mask=new Uint8Array(40*40)
    for(let y=0;y<40;y+=3) for(let x=0;x<40;x+=3) mask[y*40+x]=1
    expect(clusterDiff(mask,40,40)).toHaveLength(196)
  })
  it('clusters a solid changed full-page mask as one exact region',()=>{
    expect(clusterDiff(new Uint8Array(100*8000).fill(1),100,8000)).toEqual([{x:0,y:0,width:100,height:8000,pixels:800000,percent:100}])
  })
  it('round-trips the deterministic mask PNG at its original dimensions',()=>{
    const mask=new Uint8Array([0,1,1,0])
    const url=encodeMask(mask,2,2)
    expect(url).toBe(encodeMask(mask,2,2))
    const decoded=decodeScreenshot(url)
    expect(decoded.width).toBe(2)
    expect(Array.from(decoded.data)).toEqual([0,0,0,255,255,255,255,255,255,255,255,255,0,0,0,255])
    const png=new PNG({width:2,height:2});png.data=Buffer.from(decoded.data)
    expect(decodeScreenshot('data:image/png;base64,'+PNG.sync.write(png).toString('base64')).data).toEqual(decoded.data)
  })
  it('rejects invalid screenshots',()=>{
    expect(()=>decodeScreenshot('data:image/png;base64,aGVsbG8=')).toThrow()
    expect(()=>decodeScreenshot('https://example.com/image.png')).toThrow()
  })
})
describe('capture normalization guardrails',()=>{
  it('keeps the requested viewport height instead of clamping 1200 to 1000',()=>{
    expect(captureViewport(1920,1200)).toEqual({width:1920,height:1200})
    expect(captureViewport(280,812)).toEqual({width:280,height:812})
  })
  it('rejects a scaled render and changing page dimensions',()=>{
    expect(()=>assertNativeSize({width:960,height:600},{width:1920,height:1200},'Design')).toThrow(/No resize/)
    expect(()=>assertStablePage(1920,6000,1920,6100)).toThrow(/changed/)
    expect(()=>captureViewport(NaN,1200)).toThrow()
  })
})
