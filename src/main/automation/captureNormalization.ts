export function captureViewport(width: number, height: number) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) throw new Error('Invalid capture viewport.')
  return { width: Math.round(width), height: Math.round(height) }
}
export function assertNativeSize(actual: {width?:number;height?:number}, expected: {width:number;height:number}, label: string) {
  if (actual.width !== Math.round(expected.width) || actual.height !== Math.round(expected.height)) {
    throw new Error(`${label} is not at the requested native resolution (${actual.width}×${actual.height}, expected ${Math.round(expected.width)}×${Math.round(expected.height)}). No resize was applied.`)
  }
}
// Figma's scale=1 export rasterizes fractional frame bounds onto whole pixels.
// Permit a one-pixel rounding discrepancy only at this API boundary. Never
// resize/crop the export: the comparison still reports its decoded dimensions.
// Chromium capture tiles continue to use the strict assertNativeSize above.
export function assertFigmaNativeSize(
  actual: { width?: number; height?: number },
  expected: { width: number; height: number }
) {
  for (const axis of ['width', 'height'] as const) {
    const pixels = actual[axis]
    const bounds = expected?.[axis]
    if (pixels === undefined || !Number.isSafeInteger(pixels) || pixels < 1 ||
        !Number.isFinite(bounds) || bounds <= 0) {
      throw new Error('Figma render or frame has invalid dimensions. No resize was applied.')
    }
    if (Math.abs(pixels - Math.round(bounds)) > 1) {
      throw new Error(`Figma render is not at the requested native resolution (${actual.width}×${actual.height}, expected approximately ${Math.round(expected.width)}×${Math.round(expected.height)}; allowing 1px export rounding). No resize was applied.`)
    }
  }
}
export function assertStablePage(width: number, height: number, actualWidth: number, actualHeight: number) {
  if (width !== actualWidth || height !== actualHeight) throw new Error(`Page dimensions changed during capture (${width}×${height} to ${actualWidth}×${actualHeight}). Stabilize the page and run again; no partial or resized capture was used.`)
}
// Trigger lazy loads before capture. Bound infinite-scroll pages explicitly.
export const PREPARE_IMAGES = `(async () => {
  const deadline = Date.now() + 20000;
  await Promise.race([document.fonts.ready, new Promise((_,reject)=>setTimeout(()=>reject(new Error('Fonts did not settle.')),5000))]);
  for (let y=0;;y+=Math.max(1,innerHeight-100)) {
    if (Date.now()>deadline || y>24000) throw new Error('Lazy-loading page did not stabilize within capture limits.');
    scrollTo(0,y);
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    await new Promise(resolve=>setTimeout(resolve,60));
    if (y+innerHeight>=document.documentElement.scrollHeight) break;
  }
  for (const img of Array.from(document.images)) {
    const rect=img.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    await Promise.race([img.decode(),new Promise((_,reject)=>setTimeout(()=>reject(new Error('Image did not decode in time.')),4000))]);
    if (Date.now()>deadline) throw new Error('Image readiness exceeded capture limits.');
  }
  scrollTo(0,0);
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  return true;
})()`;
export const RESTORE_CAPTURE_TOP = `(async () => {
  const state=window.__qaAutomateAtomicState;
  for(const item of state?.positioned || []) {
    if(item.visibility) item.element.style.setProperty('visibility',item.visibility,item.visibilityPriority||'');
    else item.element.style.removeProperty('visibility');
  }
  scrollTo(0,0);
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
})()`;
