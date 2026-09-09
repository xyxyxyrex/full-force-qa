type Rgb = [number, number, number]

function srgbToLinear(channel: number): number {
  const v = channel / 255
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
}

function rgbToLab([r, g, b]: Rgb): [number, number, number] {
  const rl = srgbToLinear(r); const gl = srgbToLinear(g); const bl = srgbToLinear(b)
  const x = rl * 0.4124564 + gl * 0.3575761 + bl * 0.1804375
  const y = rl * 0.2126729 + gl * 0.7151522 + bl * 0.0721750
  const z = rl * 0.0193339 + gl * 0.1191920 + bl * 0.9503041
  const xn = 0.95047; const yn = 1.0; const zn = 1.08883
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)
  const fx = f(x / xn); const fy = f(y / yn); const fz = f(z / zn)
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}

export function deltaE(a: Rgb, b: Rgb): number {
  const labA = rgbToLab(a); const labB = rgbToLab(b)
  return Math.hypot(labA[0] - labB[0], labA[1] - labB[1], labA[2] - labB[2])
}

export function rgbToHex([r, g, b]: Rgb): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v)))
  return `#${((1 << 24) + (c(r) << 16) + (c(g) << 8) + c(b)).toString(16).slice(1)}`.toLowerCase()
}

/** Composites Figma fill + node opacity over a white canvas — the same ground the analyst is looking at. */
export function figmaColorToRgb(fills: any[], nodeOpacity = 1): Rgb | null {
  if (!Array.isArray(fills)) return null
  const solid = fills.find((f) => f.visible !== false && f.type === 'SOLID' && f.color)
  if (!solid) return null
  const alpha = (solid.opacity ?? 1) * (typeof nodeOpacity === 'number' ? nodeOpacity : 1)
  const r = (solid.color.r || 0) * 255; const g = (solid.color.g || 0) * 255; const b = (solid.color.b || 0) * 255
  return [r * alpha + 255 * (1 - alpha), g * alpha + 255 * (1 - alpha), b * alpha + 255 * (1 - alpha)]
}

export function parseCssColorToRgb(cssColor: string): Rgb | null {
  if (!cssColor) return null
  if (cssColor.startsWith('#')) {
    const hex = cssColor.slice(1)
    const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex
    if (full.length < 6) return null
    return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)]
  }
  const match = cssColor.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/)
  if (!match) return null
  const alpha = match[4] !== undefined ? parseFloat(match[4]) : 1
  const r = parseFloat(match[1]); const g = parseFloat(match[2]); const b = parseFloat(match[3])
  return [r * alpha + 255 * (1 - alpha), g * alpha + 255 * (1 - alpha), b * alpha + 255 * (1 - alpha)]
}
