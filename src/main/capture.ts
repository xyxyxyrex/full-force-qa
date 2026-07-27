import { BrowserWindow } from 'electron'

export function sanitizeUrl(rawUrl: string): string {
  if (!rawUrl) return ''
  let url = rawUrl.trim()
  url = url.replace(/&amp;/gi, '&')
  url = url.replace(/&amp;/gi, '&')
  url = url.replace(/&lt;/gi, '<')
  url = url.replace(/&gt;/gi, '>')
  url = url.replace(/&quot;/gi, '"')
  url = url.replace(/&#39;/gi, "'")
  return url
}

/**
 * Opens the URL in a hidden BrowserWindow (shares default session for auth cookies),
 * waits for dynamic rendering, scrolls to load lazy assets, injects <base href="URL">,
 * and extracts the full native outerHTML.
 */
export async function captureUrl(rawUrl: string): Promise<string> {
  const url = sanitizeUrl(rawUrl)
  const captureWindow = new BrowserWindow({
    width: 1920,
    height: 1080,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      javascript: true,
      webSecurity: false
    }
  })

  try {
    let httpStatusCode = 200
    captureWindow.webContents.on('did-navigate', (_e, _navUrl, httpResponseCode) => {
      if (httpResponseCode) httpStatusCode = httpResponseCode
    })

    await captureWindow.loadURL(url)
    console.log('[capture] Pure Chromium page loaded:', url)

    // Wait for page load + extra 3s for dynamic JS rendering
    await captureWindow.webContents.executeJavaScript(`
      new Promise((resolve) => {
        if (document.readyState === 'complete') {
          setTimeout(resolve, 3000);
        } else {
          window.addEventListener('load', () => setTimeout(resolve, 3000));
          setTimeout(resolve, 6000);
        }
      })
    `)
    console.log('[capture] 3s post-load wait complete')

    // Detect 404 Page Not Found or WP Login Redirect (session expired)
    const pageCheck: { is404OrLogin: boolean; title: string; reason: string } = await captureWindow.webContents.executeJavaScript(`
      (() => {
        try {
          const title = document.title || '';
          const lowerTitle = title.toLowerCase();
          const is404Body = document.body ? (
            document.body.classList.contains('error404') ||
            document.body.classList.contains('page-not-found') ||
            !!document.querySelector('.error-404, #error-404')
          ) : false;
          const titleHas404 = lowerTitle.includes('404 page not found') || lowerTitle.includes('page not found') || lowerTitle.includes('page cannot be found') || lowerTitle.startsWith('404 -') || lowerTitle === '404';
          const isLoginPage = window.location.href.includes('wp-login.php') || !!document.querySelector('#loginform');
          if (isLoginPage) return { is404OrLogin: true, title, reason: 'WordPress Login Redirect' };
          if (is404Body || titleHas404) return { is404OrLogin: true, title, reason: '404 Page Not Found' };
          return { is404OrLogin: false, title, reason: '' };
        } catch(e) {
          return { is404OrLogin: false, title: '', reason: '' };
        }
      })()
    `)

    if (httpStatusCode === 404 || pageCheck.is404OrLogin) {
      console.warn(`[capture] ⚠ Session Expired / 404 Warning: ${pageCheck.reason} ("${pageCheck.title}") - URL: ${captureWindow.webContents.getURL()}`)
    }

    // Scroll through page to trigger lazy loading of images & below-the-fold content
    await captureWindow.webContents.executeJavaScript(`
      new Promise((resolve) => {
        try {
          const scrollHeight = document.body ? document.body.scrollHeight : 5000;
          const viewportH = window.innerHeight || 1080;
          const steps = Math.ceil(scrollHeight / viewportH);
          let i = 0;
          function step() {
            if (i <= steps) {
              window.scrollTo(0, i * viewportH);
              i++;
              requestAnimationFrame(step);
            } else {
              window.scrollTo(0, 0);
              setTimeout(resolve, 1000);
            }
          }
          step();
        } catch(e) { resolve(); }
      })
    `)

    // Convert all relative <link>, <script>, <img>, <a> URLs into absolute HTTPS URLs
    // so every stylesheet (e.g. flooring-lp.css), image, font, and script loads
    // 100% cleanly in the canvas iframe regardless of origin.
    await captureWindow.webContents.executeJavaScript(`
      (() => {
        try {
          document.querySelectorAll('link[href]').forEach(el => {
            try { if (el.href) el.setAttribute('href', el.href); } catch(e) {}
          });
          document.querySelectorAll('script[src]').forEach(el => {
            try { if (el.src) el.setAttribute('src', el.src); } catch(e) {}
          });
          document.querySelectorAll('img[src]').forEach(el => {
            try { if (el.src) el.setAttribute('src', el.src); } catch(e) {}
          });
          document.querySelectorAll('a[href]').forEach(el => {
            try { if (el.href) el.setAttribute('href', el.href); } catch(e) {}
          });
        } catch(e) {}
      })()
    `)

    // Inject <base href="URL"> into <head> as fallback
    await captureWindow.webContents.executeJavaScript(`
      (() => {
        try {
          let base = document.querySelector('base');
          if (!base) {
            base = document.createElement('base');
            if (document.head) {
              document.head.insertBefore(base, document.head.firstChild);
            }
          }
          base.setAttribute('href', ${JSON.stringify(url)});
        } catch(e) {}
      })()
    `)

    // Extract exact document HTML as rendered by Chromium
    const html: string = await captureWindow.webContents.executeJavaScript(`
      document.documentElement ? document.documentElement.outerHTML : ''
    `)

    console.log('[capture] Pure HTML extracted successfully length:', html.length)
    return html || '<html><body></body></html>'
  } finally {
    captureWindow.destroy()
  }
}
