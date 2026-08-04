import { app, BrowserWindow, session } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync, statSync } from 'fs'
import type { SnapshotItem } from '../shared/types'
import { captureUrl } from './capture'
import { freezeSnapshot } from './snapshot'
import sharp from 'sharp'

function getSnapshotsDir(projectId: string): string {
  const dir = join(app.getPath('userData'), 'snapshots', projectId.replace(/[^a-zA-Z0-9_-]/g, '_'))
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
}

type CapturedImage = {
  buffer: Buffer
  mimeType: 'image/jpeg' | 'image/png'
  extension: 'jpg' | 'png'
  height: number
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function preparePositionedElementsForCapture(win: BrowserWindow): Promise<void> {
  try {
    await win.webContents.executeJavaScript(`
      (() => {
        window.scrollTo(0, 0);
        if (document.body) document.body.scrollTop = 0;
        if (document.documentElement) document.documentElement.scrollTop = 0;

        document.documentElement.style.setProperty('scroll-behavior', 'auto', 'important');
        document.documentElement.style.setProperty('scroll-snap-type', 'none', 'important');

        if (document.body) {
          document.body.style.setProperty('scroll-behavior', 'auto', 'important');
          document.body.style.setProperty('scroll-snap-type', 'none', 'important');
        }

        let fixedCount = 0;
        let stickyCount = 0;

        document.querySelectorAll('*').forEach((element) => {
          if (!(element instanceof HTMLElement)) return;
          if (element === document.body || element === document.documentElement) return;

          const computed = window.getComputedStyle(element);
          const position = computed.position;

          if (position !== 'fixed' && position !== 'sticky') return;
          if (computed.display === 'none' || computed.visibility === 'hidden') return;

          const rect = element.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return;

          if (position === 'sticky') {
            element.dataset.snapshotPositionType = 'sticky';
            element.style.setProperty('position', 'relative', 'important');
            element.style.setProperty('top', 'auto', 'important');
            element.style.setProperty('right', 'auto', 'important');
            element.style.setProperty('bottom', 'auto', 'important');
            element.style.setProperty('left', 'auto', 'important');
            element.style.setProperty('transform', 'none', 'important');
            stickyCount++;
            return;
          }

          const isBottomAnchored =
            computed.bottom !== 'auto' &&
            (computed.top === 'auto' || rect.top >= window.innerHeight / 2);

          element.dataset.snapshotPositionType = 'fixed';
          element.dataset.snapshotFixedAnchor = isBottomAnchored ? 'bottom' : 'top';
          element.dataset.snapshotOriginalVisibility = computed.visibility || 'visible';
          element.dataset.snapshotOriginalOpacity = computed.opacity || '1';
          element.style.setProperty('pointer-events', 'none', 'important');
          fixedCount++;
        });

        return { fixedCount, stickyCount };
      })()
    `)

  } catch (error) {
    console.warn('[Snapshot Main Debug] Failed to audit fixed/sticky elements:', error)
  }
}

async function setPositionedElementsForTile(
  win: BrowserWindow,
  showTopFixed: boolean,
  showBottomFixed: boolean
): Promise<void> {
  await win.webContents.executeJavaScript(`
    (() => {
      document.querySelectorAll('*').forEach((element) => {
        if (!(element instanceof HTMLElement)) return;
        if (element === document.body || element === document.documentElement) return;

        const computed = window.getComputedStyle(element);
        let type = element.dataset.snapshotPositionType || '';

        /*
         * Elementor and other page builders can change an element to fixed or
         * sticky only after a scroll event. Audit those late changes here too.
         */
        if (!type && computed.display !== 'none' && computed.visibility !== 'hidden') {
          const rect = element.getBoundingClientRect();

          if (rect.width > 0 && rect.height > 0 && computed.position === 'sticky') {
            type = 'sticky';
            element.dataset.snapshotPositionType = type;
          } else if (rect.width > 0 && rect.height > 0 && computed.position === 'fixed') {
            const isBottomAnchored =
              computed.bottom !== 'auto' &&
              (computed.top === 'auto' || rect.top >= window.innerHeight / 2);

            type = 'fixed';
            element.dataset.snapshotPositionType = type;
            element.dataset.snapshotFixedAnchor = isBottomAnchored ? 'bottom' : 'top';
            element.dataset.snapshotOriginalVisibility = computed.visibility || 'visible';
            element.dataset.snapshotOriginalOpacity = computed.opacity || '1';
          }
        }

        if (type === 'sticky') {
          element.style.setProperty('position', 'relative', 'important');
          element.style.setProperty('top', 'auto', 'important');
          element.style.setProperty('right', 'auto', 'important');
          element.style.setProperty('bottom', 'auto', 'important');
          element.style.setProperty('left', 'auto', 'important');
          element.style.setProperty('transform', 'none', 'important');
          return;
        }

        if (type !== 'fixed') return;

        const anchor = element.dataset.snapshotFixedAnchor || 'top';
        const shouldShow = anchor === 'bottom' ? ${showBottomFixed} : ${showTopFixed};

        element.style.setProperty('pointer-events', 'none', 'important');

        if (shouldShow) {
          element.style.setProperty(
            'visibility',
            element.dataset.snapshotOriginalVisibility || 'visible',
            'important'
          );
          element.style.setProperty(
            'opacity',
            element.dataset.snapshotOriginalOpacity || '1',
            'important'
          );
        } else {
          element.style.setProperty('visibility', 'hidden', 'important');
          element.style.setProperty('opacity', '0', 'important');
        }
      });
    })()
  `)
}

async function normalizeCapturedTile(
  input: Buffer,
  width: number,
  height: number
): Promise<Buffer> {
  const metadata = await sharp(input).metadata()

  if (metadata.width === width && metadata.height === height) {
    return input
  }

  return sharp(input)
    .resize(width, height, { fit: 'fill' })
    .png()
    .toBuffer()
}

async function stitchTiles(
  width: number,
  height: number,
  tiles: Array<{ input: Buffer; top: number; left: number }>
): Promise<CapturedImage> {
  const pipeline = sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 }
    }
  }).composite(tiles)

  // JPEG dimensions are limited, so use PNG only for exceptionally tall pages.
  if (height > 65000) {
    const buffer = await pipeline.png({ compressionLevel: 8 }).toBuffer()
    return { buffer, mimeType: 'image/png', extension: 'png', height }
  }

  const buffer = await pipeline
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer()

  return { buffer, mimeType: 'image/jpeg', extension: 'jpg', height }
}

async function captureFullPageWithScrollAndStitch(
  win: BrowserWindow,
  targetWidth: number,
  totalHeight: number,
  requestedViewportHeight: number
): Promise<CapturedImage> {
  try {
    win.setContentSize(targetWidth, Math.max(600, requestedViewportHeight))
  } catch {}

  const viewport: { width: number; height: number } = await win.webContents.executeJavaScript(`
    (() => ({
      width: Math.round(window.innerWidth),
      height: Math.round(window.innerHeight)
    }))()
  `)

  const captureWidth = Math.max(1, viewport.width || targetWidth)
  const captureHeight = Math.max(600, viewport.height || requestedViewportHeight)
  const overlap = Math.min(200, Math.max(0, Math.floor(captureHeight * 0.2)))
  const step = Math.max(1, captureHeight - overlap)
  const maxScrollY = Math.max(0, totalHeight - captureHeight)
  const requestedPositions: number[] = []

  for (let y = 0; y < maxScrollY; y += step) {
    requestedPositions.push(y)
  }

  requestedPositions.push(maxScrollY)

  const positions = requestedPositions.filter(
    (value, index, values) => index === 0 || value !== values[index - 1]
  )

  const tiles: Array<{ input: Buffer; top: number; left: number }> = []
  let previousActualY = -1

  for (let index = 0; index < positions.length; index++) {
    const requestedY = positions[index]
    const isFirstTile = index === 0
    const isLastTile = index === positions.length - 1

    const actualY: number = await win.webContents.executeJavaScript(`
      new Promise((resolve) => {
        const targetY = Math.min(${requestedY}, Math.max(0, ${totalHeight} - window.innerHeight));

        window.scrollTo(0, targetY);
        if (document.body) document.body.scrollTop = targetY;
        if (document.documentElement) document.documentElement.scrollTop = targetY;

        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            resolve(Math.round(
              window.scrollY ||
              document.documentElement.scrollTop ||
              (document.body ? document.body.scrollTop : 0) ||
              0
            ));
          });
        });
      })
    `)

    if (actualY === previousActualY && tiles.length > 0) {
      continue
    }

    previousActualY = actualY

    await setPositionedElementsForTile(win, isFirstTile, isLastTile)
    await wait(250)

    const visibleHeight = Math.min(captureHeight, totalHeight - actualY)
    const nativeTile = await win.webContents.capturePage(
      { x: 0, y: 0, width: captureWidth, height: visibleHeight },
      { stayHidden: true, stayAwake: true }
    )

    const normalizedTile = await normalizeCapturedTile(
      nativeTile.toPNG(),
      targetWidth,
      visibleHeight
    )

    tiles.push({
      input: normalizedTile,
      top: actualY,
      left: 0
    })
  }

  await win.webContents.executeJavaScript(`
    window.scrollTo(0, 0);
    if (document.body) document.body.scrollTop = 0;
    if (document.documentElement) document.documentElement.scrollTop = 0;
  `).catch(() => {})

  if (tiles.length === 0) {
    throw new Error('Scroll-and-stitch capture produced no image tiles')
  }

  return stitchTiles(targetWidth, totalHeight, tiles)
}

function getDataUrlExtension(dataUrl: string): 'png' | 'jpg' | 'webp' {
  const match = dataUrl.match(/^data:image\/(png|jpe?g|webp);base64,/i)
  const format = match?.[1]?.toLowerCase()

  if (format === 'png') return 'png'
  if (format === 'webp') return 'webp'
  return 'jpg'
}

function getImageMimeFromBuffer(buffer: Buffer): string {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return 'image/png'
  }

  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp'
  }

  return 'image/jpeg'
}

export async function createSnapshot(params: {
  projectId: string
  url: string
  type: 'image' | 'html'
  title?: string
  htmlContent?: string
  dataUrl?: string
  viewportWidth?: number
  viewportHeight?: number
}): Promise<{ success: boolean; snapshot?: SnapshotItem; error?: string }> {
  try {
    const { projectId, url, type, title, htmlContent, dataUrl: directDataUrl, viewportWidth, viewportHeight } = params
    const snapshotsDir = getSnapshotsDir(projectId)
    const id = `snap_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`
    const timestamp = Date.now()
    const targetWidth = viewportWidth || 1920
    const initialHeight = viewportHeight || 1200
    const timeStr = new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    const name = title || `${targetWidth}x${initialHeight} • ${timeStr}`
    let dataUrl = ''
    let fileSizeBytes = 0
    const itemPath = join(snapshotsDir, `${id}.json`)
    let dataPath = join(snapshotsDir, `${id}.${type === 'image' ? 'jpg' : 'html'}`)

    if (type === 'image') {
      if (directDataUrl) {
        dataUrl = directDataUrl
        const extension = getDataUrlExtension(directDataUrl)
        dataPath = join(snapshotsDir, `${id}.${extension}`)
        const base64Data = directDataUrl.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, '')
        const imageBuffer = Buffer.from(base64Data, 'base64')
        writeFileSync(dataPath, imageBuffer)
        fileSizeBytes = imageBuffer.length
      } else {
        // Create hidden window forced to targetWidth CSS content size with shared defaultSession (login cookies)
        const win = new BrowserWindow({
          width: targetWidth,
          height: initialHeight,
          useContentSize: true,
          show: false,
          enableLargerThanScreen: true,
          webPreferences: {
            session: session.defaultSession,
            nodeIntegration: false,
            contextIsolation: true,
            webSecurity: false
          }
        })

        try {
          win.setContentSize(targetWidth, initialHeight)
          win.webContents.setZoomFactor(1.0)
          win.webContents.setBackgroundThrottling(false)
          if (targetWidth < 768) {
            win.webContents.setUserAgent(
              'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1'
            )
          }

          if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
            try {
              await Promise.race([
                win.loadURL(url),
                new Promise((r) => setTimeout(r, 6000))
              ])
            } catch (e) {
              console.warn('[Snapshot Main Debug] loadURL timeout/error:', e)
            }
          } else if (htmlContent) {
            let baseHtml = htmlContent
            if (url && !baseHtml.toLowerCase().includes('<base ')) {
              baseHtml = baseHtml.replace(/<head>/i, `<head><base href="${url}">`)
            }
            await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(baseHtml)}`)
          }

          try {
            await win.webContents.insertCSS(`
              ::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }
              * { content-visibility: visible !important; contain: none !important; }
              html, body, #page, #wrapper, .site, #site-canvas, .elementor, main, .site-content {
                height: auto !important;
                min-height: 100% !important;
                max-height: none !important;
                overflow: visible !important;
                overflow-x: visible !important;
                overflow-y: visible !important;
              }
              /* Ensure all sections and vh elements expand naturally without height caps */
              [style*="vh"], [class*="vh"], [class*="fullscreen"], .elementor-section-height-full, .elementor-section {
                height: auto !important;
                min-height: 0 !important;
                max-height: none !important;
                overflow: visible !important;
              }
              *, *::before, *::after {
                animation-duration: 0s !important;
                animation-delay: 0s !important;
                transition-duration: 0s !important;
                transition-delay: 0s !important;
              }
              .elementor-invisible, [data-aos], .wow, [data-sal], .sal-animate, .os-animation, .animated, [class*="animated"], [class*="invisible"], .lazyload, .lazyloading {
                opacity: 1 !important;
                visibility: visible !important;
                transform: none !important;
                animation: none !important;
                transition: none !important;
              }
            `)
          } catch {}

          // Wait for DOM ready + stylesheets & fonts to settle
          await win.webContents.executeJavaScript(`
            new Promise((resolve) => {
              const checkStyles = () => {
                const links = Array.from(document.querySelectorAll('link[rel="stylesheet"]'));
                let pending = links.length;
                if (pending === 0) return setTimeout(resolve, 500);
                let done = false;
                const onDone = () => {
                  pending--;
                  if (pending <= 0 && !done) {
                    done = true;
                    setTimeout(resolve, 500);
                  }
                };
                links.forEach(link => {
                  if (link.sheet) {
                    onDone();
                  } else {
                    link.addEventListener('load', onDone, { once: true });
                    link.addEventListener('error', onDone, { once: true });
                  }
                });
                setTimeout(() => { if (!done) { done = true; resolve(); } }, 3500);
              };
              if (document.readyState === 'complete' || document.readyState === 'interactive') {
                checkStyles();
              } else {
                window.addEventListener('DOMContentLoaded', checkStyles, { once: true });
                setTimeout(resolve, 4000);
              }
            })
          `).catch(() => {})

          await win.webContents.executeJavaScript(`
            document.fonts && document.fonts.ready
              ? document.fonts.ready.then(() => true).catch(() => true)
              : Promise.resolve(true)
          `).catch(() => {})

          // Step 1: Force load ALL lazy images, resolve data-src/srcset, force-reveal onscroll elements & wait for all images to complete loading
          await win.webContents.executeJavaScript(`
            new Promise((resolve) => {
              try {
                // A. Convert all lazy attributes to real src/srcset
                document.querySelectorAll('img, source, iframe').forEach(el => {
                  el.setAttribute('loading', 'eager');
                  const dSrc = el.getAttribute('data-src') || el.getAttribute('data-lazy-src') || el.dataset?.src || el.dataset?.lazySrc;
                  if (dSrc) el.setAttribute('src', dSrc);
                  const dSrcSet = el.getAttribute('data-srcset') || el.dataset?.srcset;
                  if (dSrcSet) el.setAttribute('srcset', dSrcSet);
                });
                document.querySelectorAll('[data-bg], [data-background]').forEach(el => {
                  const bg = el.getAttribute('data-bg') || el.getAttribute('data-background');
                  if (bg) el.style.backgroundImage = 'url("' + bg + '")';
                });

                // B. Force reveal scroll animation elements & override content-visibility & sticky headers
                const style = document.createElement('style');
                style.innerHTML = \`
                  * { content-visibility: visible !important; contain: none !important; }
                  html, body, #page, #wrapper, .site, #site-canvas, .elementor, main, .site-content {
                    height: auto !important; min-height: 100% !important; max-height: none !important;
                    overflow: visible !important; overflow-x: visible !important; overflow-y: visible !important;
                  }
                  *, *::before, *::after {
                    animation-duration: 0s !important; animation-delay: 0s !important;
                    transition-duration: 0s !important; transition-delay: 0s !important;
                  }
                  .elementor-invisible, [data-aos], .wow, [data-sal], .sal-animate, .os-animation, .animated, [class*="animated"], [class*="invisible"] {
                    opacity: 1 !important; visibility: visible !important; transform: none !important; animation: none !important; transition: none !important;
                  }
                  /* Hide cookie consent banners & popups during snapshot */
                  #cookie-notice, .cookie-notice, #onetrust-consent-sdk, .cc-window, #cmplz-cookiebanner, .grecaptcha-badge, .cookie-banner, .cli-modal-backdrop, #cliModal, .cookie-law-info-bar {
                    display: none !important;
                  }
                \`;
                document.head.appendChild(style);

                document.querySelectorAll('.elementor-invisible').forEach(el => el.classList.remove('elementor-invisible'));

                // C. Smooth scroll pass to trigger lazy-load IntersectionObservers
                let currentY = 0;
                const distance = 600;
                const timer = setInterval(() => {
                  const scrollH = Math.max(
                    document.body ? document.body.scrollHeight : 0,
                    document.documentElement ? document.documentElement.scrollHeight : 0
                  );
                  window.scrollBy(0, distance);
                  currentY += distance;
                  if (currentY >= scrollH + 1500) {
                    clearInterval(timer);
                    window.scrollTo(0, 0);

                    // D. Image Safety Net: Wait until all <img> tags in DOM finish loading
                    const imgs = Array.from(document.images);
                    let loadedCount = 0;
                    const checkDone = () => {
                      loadedCount++;
                      if (loadedCount >= imgs.length) resolve();
                    };
                    if (imgs.length === 0) resolve();
                    imgs.forEach(img => {
                      if (img.complete) {
                        checkDone();
                      } else {
                        img.addEventListener('load', checkDone, { once: true });
                        img.addEventListener('error', checkDone, { once: true });
                      }
                    });
                    setTimeout(resolve, 5000); // image-loading safety timeout fallback
                  }
                }, 75);
              } catch(e) { resolve(); }
            })
          `)

          // Audit fixed/sticky elements before scroll capture. Sticky elements are neutralized in-flow;
          // fixed elements are shown only in the appropriate first or final screenshot tile.
          await preparePositionedElementsForCapture(win)
          await wait(150)

          // Step 2: Wait until the page height stops changing, then measure the complete document.
          const fullHeightCSS: number = await win.webContents.executeJavaScript(`
            new Promise(async (resolve) => {
              const measureHeight = () => {
                try {
                  [document.documentElement, document.body, document.querySelector('#page'), document.querySelector('#wrapper'), document.querySelector('.elementor')].forEach(el => {
                    if (el && el.style) {
                      el.style.height = 'auto';
                      el.style.maxHeight = 'none';
                      el.style.overflow = 'visible';
                    }
                  });
                } catch(e) {}

                const body = document.body;
                const doc = document.documentElement;
                let maxH = Math.max(
                  body ? body.scrollHeight : 0,
                  doc ? doc.scrollHeight : 0,
                  body ? body.offsetHeight : 0,
                  doc ? doc.offsetHeight : 0,
                  body ? Math.ceil(body.getBoundingClientRect().height) : 0,
                  doc ? Math.ceil(doc.getBoundingClientRect().height) : 0,
                  ${initialHeight}
                );

                try {
                  const scrollY = window.scrollY || 0;
                  document.querySelectorAll('body > *, #page, #wrapper, main, section, article, footer, .elementor, .site-content').forEach(el => {
                    if (el && typeof el.getBoundingClientRect === 'function') {
                      const rect = el.getBoundingClientRect();
                      const bottomY = Math.ceil(rect.top + scrollY + rect.height);
                      if (bottomY > maxH) maxH = bottomY;
                      if (el.scrollHeight && el.scrollHeight > maxH) maxH = el.scrollHeight;
                    }
                  });
                } catch(e) {}

                return Math.ceil(maxH);
              };

              let maxSeen = measureHeight();
              let previous = maxSeen;
              let stableChecks = 0;

              for (let i = 0; i < 20; i++) {
                await new Promise(r => setTimeout(r, 250));
                const current = measureHeight();
                maxSeen = Math.max(maxSeen, current);

                if (Math.abs(current - previous) <= 1) {
                  stableChecks++;
                } else {
                  stableChecks = 0;
                }

                previous = current;
                if (stableChecks >= 3) break;
              }

              resolve(Math.ceil(maxSeen));
            })
          `)

          const totalH = Math.max(fullHeightCSS, initialHeight)
          // Step 3: Capture each visible viewport while scrolling, then stitch the frames.
          // This mirrors the method used by full-page screenshot browser extensions.
          const captured = await captureFullPageWithScrollAndStitch(
            win,
            targetWidth,
            totalH,
            initialHeight
          )

          const imageBuffer = captured.buffer
          dataPath = join(snapshotsDir, `${id}.${captured.extension}`)
          dataUrl = `data:${captured.mimeType};base64,${captured.buffer.toString('base64')}`

          writeFileSync(dataPath, imageBuffer)
          fileSizeBytes = imageBuffer.length
        } finally {
          win.destroy()
        }
      }
    } else {
      // HTML Snapshot: use provided htmlContent or fetch + freeze HTML
      let rawHtml = htmlContent
      if (!rawHtml) {
        rawHtml = await captureUrl(url)
      }
      const frozenHtml = freezeSnapshot(rawHtml, url)
      const buffer = Buffer.from(frozenHtml, 'utf-8')
      writeFileSync(dataPath, buffer)
      dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(frozenHtml)}`
      fileSizeBytes = buffer.length
    }

    const snapshot: SnapshotItem = {
      id,
      projectId,
      title: name,
      type,
      timestamp,
      fileSizeBytes,
      fileSizeFormatted: formatBytes(fileSizeBytes),
      dataUrl,
      url,
      viewportWidth: targetWidth,
      viewportHeight: initialHeight
    }

    // Save snapshot metadata JSON
    writeFileSync(itemPath, JSON.stringify(snapshot, null, 2), 'utf-8')

    return { success: true, snapshot }
  } catch (err: any) {
    console.error('[snapshotManager] Error creating snapshot:', err)
    return { success: false, error: err.message || 'Failed to create snapshot' }
  }
}

export async function getSnapshots(projectId: string): Promise<SnapshotItem[]> {
  try {
    const snapshotsDir = getSnapshotsDir(projectId)
    if (!existsSync(snapshotsDir)) return []

    const files = readdirSync(snapshotsDir).filter((f) => f.endsWith('.json'))
    const items: SnapshotItem[] = []

    for (const f of files) {
      try {
        const fullPath = join(snapshotsDir, f)
        const content = readFileSync(fullPath, 'utf-8')
        const item: SnapshotItem = JSON.parse(content)

        // Read associated data file if dataUrl is empty.
        // New snapshots use .jpg or .png; .webp remains supported for older snapshots.
        const candidatePaths = item.type === 'image'
          ? ['jpg', 'png', 'webp', 'jpeg'].map((ext) => join(snapshotsDir, `${item.id}.${ext}`))
          : [join(snapshotsDir, `${item.id}.html`)]
        const dataPath = candidatePaths.find((candidate) => existsSync(candidate))

        if (dataPath) {
          const stats = statSync(dataPath)
          item.fileSizeBytes = stats.size
          item.fileSizeFormatted = formatBytes(stats.size)

          if (!item.dataUrl) {
            if (item.type === 'image') {
              const buf = readFileSync(dataPath)
              const mimeType = getImageMimeFromBuffer(buf)
              item.dataUrl = `data:${mimeType};base64,${buf.toString('base64')}`
            } else {
              const htmlStr = readFileSync(dataPath, 'utf-8')
              item.dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(htmlStr)}`
            }
          }
        }

        items.push(item)
      } catch {
        /* ignore broken files */
      }
    }

    return items.sort((a, b) => b.timestamp - a.timestamp)
  } catch (err) {
    console.error('[snapshotManager] Error getting snapshots:', err)
    return []
  }
}

export async function deleteSnapshot(snapshotId: string): Promise<{ success: boolean }> {
  try {
    // Search across user data snapshots
    const baseDir = join(app.getPath('userData'), 'snapshots')
    if (!existsSync(baseDir)) return { success: true }

    const projDirs = readdirSync(baseDir)
    for (const pDir of projDirs) {
      const fullDir = join(baseDir, pDir)
      const metaPath = join(fullDir, `${snapshotId}.json`)
      if (existsSync(metaPath)) {
        try { unlinkSync(metaPath) } catch {}
        try { unlinkSync(join(fullDir, `${snapshotId}.jpg`)) } catch {}
        try { unlinkSync(join(fullDir, `${snapshotId}.jpeg`)) } catch {}
        try { unlinkSync(join(fullDir, `${snapshotId}.png`)) } catch {}
        try { unlinkSync(join(fullDir, `${snapshotId}.webp`)) } catch {}
        try { unlinkSync(join(fullDir, `${snapshotId}.html`)) } catch {}
        return { success: true }
      }
    }
    return { success: true }
  } catch (err) {
    console.error('[snapshotManager] Error deleting snapshot:', err)
    return { success: false }
  }
}
