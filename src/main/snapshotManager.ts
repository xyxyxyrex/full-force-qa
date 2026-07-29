import { app, BrowserWindow, screen, session } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync, statSync } from 'fs'
import type { SnapshotItem } from '../shared/types'
import { captureUrl } from './capture'
import { freezeSnapshot } from './snapshot'

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
  console.log('[Snapshot Main Debug] createSnapshot called with params:', params)
  try {
    const { projectId, url, type, title, htmlContent, dataUrl: directDataUrl, viewportWidth, viewportHeight } = params
    const snapshotsDir = getSnapshotsDir(projectId)
    const id = `snap_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`
    const timestamp = Date.now()
    const targetWidth = viewportWidth || 1920
    const initialHeight = viewportHeight || 1200
    const timeStr = new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    const name = title || `${targetWidth}x${initialHeight} • ${timeStr}`
    console.log('[Snapshot Main Debug] target dimensions:', { targetWidth, initialHeight })

    let dataUrl = ''
    let fileSizeBytes = 0
    const itemPath = join(snapshotsDir, `${id}.json`)
    const dataPath = join(snapshotsDir, `${id}.${type === 'image' ? 'webp' : 'html'}`)

    if (type === 'image') {
      if (directDataUrl) {
        console.log('[Snapshot Main Debug] Using direct dataUrl provided by renderer')
        dataUrl = directDataUrl
        const base64Data = directDataUrl.replace(/^data:image\/\w+;base64,/, '')
        const imageBuffer = Buffer.from(base64Data, 'base64')
        writeFileSync(dataPath, imageBuffer)
        fileSizeBytes = imageBuffer.length
      } else {
        console.log('[Snapshot Main Debug] Creating hidden BrowserWindow with defaultSession for capture...')
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
          if (targetWidth < 768) {
            win.webContents.setUserAgent(
              'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1'
            )
          }

          console.log('[Snapshot Main Debug] Loading URL in hidden window:', url)
          try {
            await Promise.race([
              win.loadURL(url),
              new Promise((r) => setTimeout(r, 4000))
            ])
          } catch (e) {
            console.warn('[Snapshot Main Debug] loadURL timeout/error:', e)
          }

          try {
            await win.webContents.insertCSS(`
              ::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }
              .elementor-invisible, [data-aos], .wow, [data-sal], .sal-animate, .os-animation, .animated, [class*="animated"], [class*="invisible"] {
                opacity: 1 !important;
                visibility: visible !important;
                transform: none !important;
                animation: none !important;
                transition: none !important;
              }
            `)
          } catch {}

          // Wait at most 1.5s for DOM ready
          await win.webContents.executeJavaScript(`
            new Promise((resolve) => {
              const timer = setTimeout(resolve, 1500);
              if (document.readyState === 'complete' || document.readyState === 'interactive') {
                clearTimeout(timer);
                setTimeout(resolve, 500);
              } else {
                window.addEventListener('DOMContentLoaded', () => {
                  clearTimeout(timer);
                  setTimeout(resolve, 500);
                }, { once: true });
              }
            })
          `).catch(() => {})

          console.log('[Snapshot Main Debug] DOM ready, running Asset Preloader & Safety Net...')

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

                // B. Force reveal ONLY scroll animation elements (do NOT touch dropdown menus or modals)
                const style = document.createElement('style');
                style.innerHTML = \`
                  .elementor-invisible, [data-aos], .wow, [data-sal], .sal-animate, .os-animation {
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
                const distance = 400;
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
                    setTimeout(resolve, 2000); // 2s max safety timeout fallback
                  }
                }, 25);
              } catch(e) { resolve(); }
            })
          `)

          // Step 2: Measure true 100% full height of document
          const fullHeightCSS: number = await win.webContents.executeJavaScript(`
            Math.max(
              document.body ? document.body.scrollHeight : 0,
              document.documentElement ? document.documentElement.scrollHeight : 0,
              document.body ? document.body.offsetHeight : 0,
              document.documentElement ? document.documentElement.offsetHeight : 0,
              ${initialHeight}
            )
          `)

          const totalH = Math.max(fullHeightCSS, initialHeight)
          console.log('[Snapshot Main Debug] Measured true full document height:', fullHeightCSS, 'target dimensions:', { targetWidth, totalH })

          // Step 3: Use Chrome DevTools Protocol (CDP) Page.captureScreenshot with captureBeyondViewport: true!
          // CDP rasterizes the full page to JPEG directly in CPU memory without VRAM GPU texture crashes, supporting 30,000px+ long pages!
          let imageBuffer: Buffer

          try {
            if (!win.webContents.debugger.isAttached()) {
              win.webContents.debugger.attach('1.3')
            }
            await win.webContents.debugger.sendCommand('Page.enable')

            // Reset scroll position to top
            await win.webContents.executeJavaScript('window.scrollTo(0, 0); document.body.scrollTop = 0; document.documentElement.scrollTop = 0;')
            await new Promise((r) => setTimeout(r, 200))

            const cdpResult = await win.webContents.debugger.sendCommand('Page.captureScreenshot', {
              format: 'jpeg',
              quality: 85,
              captureBeyondViewport: true,
              clip: {
                x: 0,
                y: 0,
                width: targetWidth,
                height: totalH,
                scale: 1.0
              }
            })

            const base64Data = (cdpResult as any).data
            imageBuffer = Buffer.from(base64Data, 'base64')
            dataUrl = `data:image/jpeg;base64,${base64Data}`
            console.log('[Snapshot Main Debug] CDP Page.captureScreenshot successful! Buffer size:', imageBuffer.length)
          } catch (cdpErr) {
            console.warn('[Snapshot Main Debug] CDP capture failed, using win.setContentSize fallback:', cdpErr)
            const safeH = Math.min(totalH, 8000)
            win.setContentSize(targetWidth, safeH)
            await new Promise((r) => setTimeout(r, 400))
            await win.webContents.executeJavaScript('window.scrollTo(0, 0); document.body.scrollTop = 0; document.documentElement.scrollTop = 0;').catch(() => {})
            await new Promise((r) => setTimeout(r, 300))
            const image = await win.webContents.capturePage({ x: 0, y: 0, width: targetWidth, height: safeH })
            dataUrl = image.toDataURL()
            imageBuffer = image.toJPEG(85)
          } finally {
            if (win.webContents.debugger.isAttached()) {
              win.webContents.debugger.detach()
            }
          }

          writeFileSync(dataPath, imageBuffer)
          fileSizeBytes = imageBuffer.length
          console.log('[Snapshot Main Debug] Snapshot saved successfully to disk:', dataPath, 'Bytes:', fileSizeBytes)
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

        // Read associated data file if dataUrl is empty
        const ext = item.type === 'image' ? 'webp' : 'html'
        const dataPath = join(snapshotsDir, `${item.id}.${ext}`)

        if (existsSync(dataPath)) {
          const stats = statSync(dataPath)
          item.fileSizeBytes = stats.size
          item.fileSizeFormatted = formatBytes(stats.size)

          if (!item.dataUrl) {
            if (item.type === 'image') {
              const buf = readFileSync(dataPath)
              item.dataUrl = `data:image/jpeg;base64,${buf.toString('base64')}`
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
