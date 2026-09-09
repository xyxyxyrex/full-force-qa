import type { TokenAssertion } from '../../../shared/automation'
import type { DomNode } from '../utils/visualCompare'
import { AUTOMATION_TOLERANCE as tolerance } from '../../../shared/automationTolerance'
import { deltaE, figmaColorToRgb, parseCssColorToRgb, rgbToHex } from './colors'

/** Only declared design properties and available computed CSS values are asserted. */
export function compareStyles(design: any, live: DomNode): TokenAssertion[] {
  const tokens: TokenAssertion[] = []
  const style = design.style || {}
  const numeric = (name: string, expected: unknown, rawActual: string | undefined, allowed: number, unit = 'px') => {
    if (typeof expected !== 'number' || !Number.isFinite(expected)) return
    const actual = rawActual === 'normal' && name === 'letter-spacing' ? 0 : parseFloat(rawActual || '')
    const valid = Number.isFinite(actual) && (rawActual === 'normal' || /^-?[\d.]+(?:px)?$/.test(rawActual || ''))
    tokens.push({name,passed:valid && Math.abs(actual-expected)<=allowed,unresolved:!valid,
      figma:`${expected}${unit}`,css:rawActual || 'unavailable',difference:valid ? actual-expected : 'unavailable'})
  }
  numeric('font-size',style.fontSize,live.styles.fontSize,tolerance.fontSizePx)
  numeric('font-weight',style.fontWeight,live.styles.fontWeight,0,'')
  numeric('line-height',style.lineHeightPx,live.styles.lineHeight,tolerance.lineHeightPx)
  numeric('letter-spacing',style.letterSpacing,live.styles.letterSpacing,tolerance.letterSpacingPx)
  const expectedFamily = String(style.fontFamily || '').trim()
  const actualFamily = String(live.styles.fontFamily || '').split(',')[0].trim().replace(/^["']|["']$/g,'')
  if (expectedFamily) tokens.push({name:'font-family',passed:expectedFamily.toLowerCase()===actualFamily.toLowerCase(),
    unresolved:!actualFamily,figma:expectedFamily,css:actualFamily || 'unavailable'})

  const fills = (design.fills || []).filter((f:any)=>f.visible!==false)
  const solid = fills.length===1 && fills[0].type==='SOLID' ? fills[0] : undefined
  const opaque = solid && (solid.opacity ?? 1) * (design.opacity ?? 1) * (solid.color?.a ?? 1) === 1
  const actualColor = live.styles.color || ''
  const actualOpaque = !actualColor.startsWith('rgba') || /,\s*1(?:\.0+)?\s*\)$/.test(actualColor)
  const designRgb = opaque ? figmaColorToRgb(fills,design.opacity) : null
  const liveRgb = actualOpaque ? parseCssColorToRgb(actualColor) : null
  if (fills.length) {
    if (designRgb && liveRgb) {
      const difference = deltaE(designRgb,liveRgb)
      tokens.push({name:'color',passed:difference<=tolerance.colorDelta,figma:rgbToHex(designRgb),css:rgbToHex(liveRgb),difference})
    } else tokens.push({name:'color',passed:false,unresolved:true,figma:'Paint requires background/gradient context',css:actualColor || 'unavailable'})
  }
  const align = String(style.textAlignHorizontal || '').toLowerCase()
  let actualAlign = live.styles.textAlign || ''
  if (actualAlign==='start' && live.styles.direction==='ltr') actualAlign='left'
  if (actualAlign==='end' && live.styles.direction==='ltr') actualAlign='right'
  if (align) tokens.push({name:'text-align',passed:(align==='justified'?'justify':align)===actualAlign,
    unresolved:!actualAlign,figma:align,css:actualAlign || 'unavailable',isExtended:true})
  const transforms: Record<string,string> = {UPPER:'uppercase',LOWER:'lowercase',TITLE:'capitalize'}
  const transform = transforms[String(style.textCase || '').toUpperCase()]
  if (transform) tokens.push({name:'text-case',passed:live.styles.textTransform===transform,
    unresolved:!live.styles.textTransform,figma:transform,css:live.styles.textTransform || 'unavailable',isExtended:true})
  // document.fonts.check is not proof of the glyph-level rendered font.
  if (live.styles.fontLoaded==='false') tokens.push({name:'font-loaded',passed:false,unresolved:true,
    figma:expectedFamily || 'Design font',css:'Font availability check failed; rendered font unverified'})
  return tokens
}
