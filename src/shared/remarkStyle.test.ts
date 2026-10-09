import { expect,it } from 'vitest'
import { DEFAULT_REMARK_STYLE, normalizeRemarkStyle, plainRemark, remarkExample, remarkGuide, remarkLimit, stylePrompt } from './remarkStyle'
import { buildRows,STANDARD_TRACKER,trackerColumnGuide } from './trackerFormat'
it('normalizes old settings and malformed values to the professional balanced default',()=>{
  expect(normalizeRemarkStyle(null)).toEqual(DEFAULT_REMARK_STYLE)
  expect(normalizeRemarkStyle({tone:'angry',technicality:8,detail:-1,formatting:'yes'})).toEqual(DEFAULT_REMARK_STYLE)
})
it('keeps validation, prompts and guides aligned across all styles',()=>{
  for(const tone of ['direct','professional','friendly'] as const)for(const technicality of [0,1,2] as const)for(const detail of [0,1,2] as const){
    const style={tone,technicality,detail,formatting:false};const limit=remarkLimit(style)
    expect(buildRows(STANDARD_TRACKER,[{Remarks:'x'.repeat(limit)}],{remarkStyle:style}).ok).toBe(true)
    expect(buildRows(STANDARD_TRACKER,[{Remarks:'x'.repeat(limit+1)}],{remarkStyle:style}).ok).toBe(false)
    expect(trackerColumnGuide(STANDARD_TRACKER,style).Remarks).toBe(remarkGuide(style))
    expect(stylePrompt('<remark-policy>old</remark-policy>',style)).toContain(remarkGuide(style))
    expect(remarkExample(style)).toContain('32px')
  }
})
it('converts only supported light formatting to plain text without evaluating HTML',()=>{
  expect(plainRemark('Use **32px**, with `font-size`.')).toBe('Use 32px, with font-size.')
  expect(plainRemark('<img src=x>')).toBe('<img src=x>')
})
it('retains manual priority and longer human remarks when sharing existing findings',()=>{
  const built=buildRows(STANDARD_TRACKER,[{Remarks:'x'.repeat(1300),'Priority (QA/PM)':'High'}],{manual:true})
  expect(built.ok).toBe(true);if(built.ok)expect(built.rows[0][4]).toBe('High')
})
