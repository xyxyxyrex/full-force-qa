import { BrowserWindow } from 'electron'

/**
 * Opens the URL in a hidden BrowserWindow (shares default session for auth cookies),
 * waits for dynamic rendering, then extracts the full outerHTML.
 */
export async function captureUrl(url: string): Promise<string> {
  const captureWindow = new BrowserWindow({
    width: 1920,
    height: 1080,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      javascript: true,
      // Disable CORS so we can read cssRules from ALL stylesheets
      // (CDN-served CSS, Google Fonts, etc. would otherwise throw SecurityError)
      webSecurity: false
    }
  })

  try {
    await captureWindow.loadURL(url)
    console.log('[capture] Page loaded:', url)

    // Wait for page load + extra time for WP/Elementor/Gutenberg dynamic rendering
    await captureWindow.webContents.executeJavaScript(`
      new Promise((resolve) => {
        if (document.readyState === 'complete') {
          setTimeout(resolve, 3000);
        } else {
          window.addEventListener('load', () => setTimeout(resolve, 3000));
        }
      })
    `)
    console.log('[capture] 3s post-load wait complete')

    // Scroll through the entire page to trigger IntersectionObserver-based
    // entrance animations (Elementor, WP blocks, AOS, etc.) and lazy loading.
    // Without this, elements below the fold stay invisible.
    const scrollDebug: any = await captureWindow.webContents.executeJavaScript(`
      new Promise((resolve) => {
        const scrollHeight = document.body.scrollHeight;
        const viewportH = window.innerHeight;
        const steps = Math.ceil(scrollHeight / viewportH);
        let i = 0;
        function step() {
          if (i <= steps) {
            window.scrollTo(0, i * viewportH);
            i++;
            requestAnimationFrame(step);
          } else {
            // Scroll back to top, then wait for animations to settle
            window.scrollTo(0, 0);
            setTimeout(() => resolve({ scrollHeight, steps }), 1500);
          }
        }
        step();
      })
    `)
    console.log('[capture] Scroll-through complete: height=' + scrollDebug.scrollHeight + ' steps=' + scrollDebug.steps)

    // Force-reveal elements hidden by entrance animations.
    // Elementor uses .elementor-invisible { visibility: hidden } and only
    // removes it when the element is scrolled into view. AOS uses similar
    // patterns. Strip these classes so all content is visible.
    const revealDebug: any = await captureWindow.webContents.executeJavaScript(`
      (() => {
        const animClasses = [
          'elementor-invisible',
          'aos-init', 'aos-animate',
          'wow', 'animated',
          'is-hidden', 'not-visible'
        ];
        let revealed = 0;
        animClasses.forEach(cls => {
          document.querySelectorAll('.' + cls).forEach(el => {
            el.classList.remove(cls);
            revealed++;
          });
        });
        // Also force opacity/visibility on any still-hidden animated elements
        document.querySelectorAll('[data-settings]').forEach(el => {
          const settings = el.getAttribute('data-settings') || '';
          if (settings.includes('animation') || settings.includes('_animation')) {
            el.style.opacity = '1';
            el.style.visibility = 'visible';
            el.style.animationDelay = '0s';
            revealed++;
          }
        });
        return { revealed };
      })()
    `)
    console.log('[capture] Animation reveal: ' + revealDebug.revealed + ' elements forced visible')

    // ── DEBUG: dump page state before any modifications ──
    const preDebug: any = await captureWindow.webContents.executeJavaScript(`
      (() => {
        const all = document.querySelectorAll('*');
        const fixed = [];
        all.forEach(el => {
          const s = getComputedStyle(el);
          if (s.position === 'fixed' || s.position === 'sticky') {
            fixed.push({
              tag: el.tagName,
              id: el.id,
              classes: el.className?.toString?.()?.slice(0, 200) || '',
              text: (el.innerText || '').slice(0, 80),
              zIndex: s.zIndex,
              rect: { w: el.getBoundingClientRect().width, h: el.getBoundingClientRect().height }
            });
          }
        });

        // Check for iframes that might contain cookie consent
        const iframes = [];
        document.querySelectorAll('iframe').forEach(f => {
          iframes.push({ src: f.src, id: f.id, classes: f.className });
        });

        // Check for shadow DOMs
        const shadows = [];
        all.forEach(el => {
          if (el.shadowRoot) {
            shadows.push({ tag: el.tagName, id: el.id, classes: el.className?.toString?.()?.slice(0, 100) || '' });
          }
        });

        // Sample some div styles to verify computed style reading works
        const sampleDivs = [];
        const divs = document.querySelectorAll('div');
        for (let i = 0; i < Math.min(5, divs.length); i++) {
          const cs = getComputedStyle(divs[i]);
          sampleDivs.push({
            classes: divs[i].className?.toString?.()?.slice(0, 100) || '',
            fontSize: cs.fontSize,
            fontFamily: cs.fontFamily?.slice(0, 60),
            color: cs.color,
            display: cs.display,
            inlineStyle: (divs[i].getAttribute('style') || '').slice(0, 100)
          });
        }

        return {
          totalElements: all.length,
          fixedElements: fixed,
          iframeCount: iframes.length,
          iframes,
          shadowDOMCount: shadows.length,
          shadows,
          sampleDivs,
          styleSheetCount: document.styleSheets.length,
          styleTags: document.querySelectorAll('style').length,
          linkTags: document.querySelectorAll('link[rel="stylesheet"]').length
        };
      })()
    `)
    console.log('[capture] PRE-MODIFICATION STATE:')
    console.log('[capture]   Total elements:', preDebug.totalElements)
    console.log('[capture]   StyleSheets:', preDebug.styleSheetCount, '| <style>:', preDebug.styleTags, '| <link>:', preDebug.linkTags)
    console.log('[capture]   Fixed/sticky elements:', preDebug.fixedElements.length)
    preDebug.fixedElements.forEach((el: any) => {
      console.log(`[capture]     ${el.tag}#${el.id} .${el.classes.slice(0, 60)} z=${el.zIndex} "${el.text.slice(0, 40)}"`)
    })
    console.log('[capture]   Iframes:', preDebug.iframeCount)
    preDebug.iframes.forEach((f: any) => console.log(`[capture]     iframe src=${f.src} id=${f.id}`))
    console.log('[capture]   Shadow DOMs:', preDebug.shadowDOMCount)
    preDebug.shadows.forEach((s: any) => console.log(`[capture]     shadow: ${s.tag}#${s.id} .${s.classes}`))
    console.log('[capture]   Sample divs:')
    preDebug.sampleDivs.forEach((d: any) => {
      console.log(`[capture]     .${d.classes.slice(0, 40)} | font=${d.fontFamily} size=${d.fontSize} color=${d.color} display=${d.display}`)
    })

    // Remove common cookie/consent/GDPR overlays before capturing
    const cookieDebug: any = await captureWindow.webContents.executeJavaScript(`
      (() => {
        const removed = [];
        const selectors = [
          '[class*="cookie-notice"]', '[class*="cookie-consent"]', '[class*="cookie-banner"]',
          '[class*="cky-"]', '[id*="cky-"]',
          '[class*="cc-window"]', '[class*="cc-banner"]',
          '[id*="cookie-notice"]', '[id*="cookie-consent"]', '[id*="cookie-law"]',
          '[class*="gdpr"]', '[id*="gdpr"]',
          '#onetrust-consent-sdk', '.onetrust-pc-dark-filter',
          '[class*="CookieConsent"]', '[id*="CookieConsent"]',
          '[class*="cookieyes"]', '[id*="cookieyes"]',
          '.cc_banner-wrapper', '#catapult-cookie-bar',
          '[id*="truendo"]', '[class*="truendo"]',
          '[class*="osano-cm"]',
          '[class*="consent"]', '[id*="consent"]',
          '[class*="privacy-banner"]', '[class*="privacy-notice"]',
          '[aria-label*="cookie"]', '[aria-label*="consent"]',
        ];
        selectors.forEach(sel => {
          try {
            const els = document.querySelectorAll(sel);
            els.forEach(el => {
              removed.push({ selector: sel, tag: el.tagName, id: el.id, classes: el.className?.toString?.()?.slice(0, 100) || '' });
              el.remove();
            });
          } catch(e) {}
        });

        // Fallback: remove fixed/sticky overlays that contain consent-related text
        document.querySelectorAll('*').forEach(el => {
          const style = getComputedStyle(el);
          if (style.position !== 'fixed' && style.position !== 'sticky') return;
          const text = el.innerText || '';
          if (/cookie|consent|privacy|gdpr|we (use|value)/i.test(text) &&
              /accept|reject|customise|customize|agree|allow|manage/i.test(text)) {
            removed.push({ selector: 'text-fallback', tag: el.tagName, id: el.id, text: text.slice(0, 60) });
            el.remove();
          }
        });

        // Also remove any high z-index overlays/backdrops that block content
        document.querySelectorAll('*').forEach(el => {
          const style = getComputedStyle(el);
          const z = parseInt(style.zIndex, 10);
          if (z > 9000 && (style.position === 'fixed' || style.position === 'sticky')) {
            const rect = el.getBoundingClientRect();
            if (rect.width > window.innerWidth * 0.5) {
              removed.push({ selector: 'z-index-fallback', tag: el.tagName, z, w: rect.width });
              el.remove();
            }
          }
        });

        // Check if any consent-like elements remain
        const remaining = [];
        document.querySelectorAll('*').forEach(el => {
          const text = (el.innerText || '').toLowerCase();
          if (text.includes('we value your privacy') || text.includes('cookie')) {
            const s = getComputedStyle(el);
            if (s.display !== 'none') {
              remaining.push({
                tag: el.tagName, id: el.id,
                classes: el.className?.toString?.()?.slice(0, 100) || '',
                position: s.position, zIndex: s.zIndex,
                text: (el.innerText || '').slice(0, 60)
              });
            }
          }
        });

        return { removed, remaining };
      })()
    `)
    console.log('[capture] COOKIE REMOVAL:')
    console.log('[capture]   Removed:', cookieDebug.removed.length, 'elements')
    cookieDebug.removed.forEach((r: any) => console.log(`[capture]     ${r.selector} → ${r.tag}#${r.id} .${r.classes?.slice(0, 50) || ''}`))
    console.log('[capture]   Still remaining consent-like elements:', cookieDebug.remaining.length)
    cookieDebug.remaining.forEach((r: any) => {
      console.log(`[capture]     ${r.tag}#${r.id} .${r.classes?.slice(0, 50)} pos=${r.position} z=${r.zIndex} "${r.text}"`)
    })

    // Capture all CSSOM rules into an inline <style> block.
    const cssomDebug: any = await captureWindow.webContents.executeJavaScript(`
      (() => {
        const rules = [];
        let sheetErrors = 0;
        let totalSheets = document.styleSheets.length;
        let sheetsWithRules = 0;
        const fontFaces = [];
        // Resolve relative url() references against the stylesheet's own location
        function resolveUrls(cssText, baseUrl) {
          if (!baseUrl) return cssText;
          return cssText.replace(
            /url\\(\\s*["']?(?!data:|https?:\\/\\/|\\/\\/)([^"')\\s]+)["']?\\s*\\)/g,
            function(match, relPath) {
              try {
                var abs = new URL(relPath, baseUrl).href;
                return 'url("' + abs + '")';
              } catch(e) { return match; }
            }
          );
        }

        // Recursively extract rules from a stylesheet (handles @import)
        function extractRules(sheet, depth) {
          if (depth > 5) return; // prevent infinite recursion
          try {
            const sheetBase = sheet.href || document.baseURI;
            let sheetRules = 0;
            for (const rule of sheet.cssRules) {
              if (rule.type === 3) {
                // CSSImportRule — recurse into the imported stylesheet
                if (rule.styleSheet) {
                  extractRules(rule.styleSheet, depth + 1);
                }
                continue;
              }
              rules.push(resolveUrls(rule.cssText, sheetBase));
              sheetRules++;
              if (rule.type === 5) { // CSSFontFaceRule
                fontFaces.push(rule.cssText.slice(0, 120));
              }
            }
            if (sheetRules > 0) sheetsWithRules++;
          } catch(e) {
            sheetErrors++;
          }
        }

        for (const sheet of document.styleSheets) {
          extractRules(sheet, 0);
        }
        if (rules.length > 0) {
          const s = document.createElement('style');
          s.setAttribute('data-snapshot-cssom', 'true');
          s.textContent = rules.join('\\n');
          document.head.appendChild(s);
        }
        return {
          totalSheets,
          sheetsWithRules,
          sheetErrors,
          totalRules: rules.length,
          fontFaces: fontFaces.slice(0, 10),
          cssTextSize: rules.join('\\n').length
        };
      })()
    `)
    console.log('[capture] CSSOM CAPTURE:')
    console.log(`[capture]   Sheets: ${cssomDebug.totalSheets} total, ${cssomDebug.sheetsWithRules} with rules, ${cssomDebug.sheetErrors} errors`)
    console.log(`[capture]   Rules: ${cssomDebug.totalRules} captured (${(cssomDebug.cssTextSize / 1024).toFixed(1)} KB)`)
    console.log(`[capture]   @font-face declarations: ${cssomDebug.fontFaces.length}`)
    cssomDebug.fontFaces.forEach((ff: any) => console.log(`[capture]     ${ff}`))

    // Preserve CSS custom properties (--var) on :root / body / html.
    // Elementor and many WP themes rely heavily on CSS variables for layout,
    // colors, and typography. These come from JS-generated <style> blocks
    // that are lost when scripts are stripped.
    await captureWindow.webContents.executeJavaScript(`
      (() => {
        ['html', 'body'].forEach(tag => {
          const el = document.querySelector(tag);
          if (!el) return;
          const cs = getComputedStyle(el);
          const vars = [];
          // Iterate all computed properties looking for custom props
          for (let i = 0; i < cs.length; i++) {
            const prop = cs[i];
            if (prop.startsWith('--')) {
              vars.push(prop + ':' + cs.getPropertyValue(prop));
            }
          }
          if (vars.length > 0) {
            const existing = el.getAttribute('style') || '';
            el.setAttribute('style', existing + (existing ? ';' : '') + vars.join(';'));
          }
        });
      })()
    `)

    // Bake critical computed styles as inline styles on every visible element.
    const bakeDebug: any = await captureWindow.webContents.executeJavaScript(`
      (() => {
        // Only bake properties that do NOT change across breakpoints.
        // Responsive properties (font-size, line-height, padding, display,
        // flex-direction, etc.) are intentionally EXCLUDED — they are
        // already captured via CSSOM rules (including @media queries) and
        // baking them as inline styles would override those media queries.
        // font-family is NOT baked — it's already in the captured CSSOM
        // rules.  Baking it as inline style prevents user edits from
        // taking effect (inline styles override GrapesJS CSS changes).
        const textProps = [
          'font-style','color',
          'text-transform','text-decoration'
        ];
        const visualProps = [
          'background-color','background-image',
          'border-top-color','border-right-color','border-bottom-color','border-left-color',
          'border-top-width','border-right-width','border-bottom-width','border-left-width',
          'border-top-style','border-right-style','border-bottom-style','border-left-style',
          'border-radius','box-shadow','opacity'
        ];
        const layoutProps = [];

        const defaults = new Set([
          'rgba(0, 0, 0, 0)','transparent','none','0px','0','normal',
          'auto','static','visible','stretch','start','row','nowrap',
          '1','medium','currentcolor'
        ]);

        const selector = [
          'h1','h2','h3','h4','h5','h6','p','span','a','li','td','th',
          'label','button','blockquote','strong','em','i','b','small','sup','sub',
          'div','section','article','header','footer','nav','main',
          'figure','figcaption','ul','ol','dl','dt','dd','img'
        ].join(',');

        let totalProcessed = 0;
        let totalSkipped = 0;
        let totalBaked = 0;
        const samples = [];

        document.querySelectorAll(selector).forEach(el => {
          const cs = getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden') {
            totalSkipped++;
            return;
          }
          totalProcessed++;

          const existing = el.getAttribute('style') || '';
          const additions = [];

          const tag = el.tagName.toLowerCase();
          const isContainer = /^(div|section|article|header|footer|nav|main|figure|figcaption|ul|ol|dl)$/.test(tag);
          const props = isContainer
            ? [...textProps, ...visualProps, ...layoutProps]
            : [...textProps, ...visualProps];

          props.forEach(p => {
            if (existing.includes(p)) return;
            const v = cs.getPropertyValue(p);
            if (!v || defaults.has(v)) return;
            if (p === 'background-image' && v === 'none') return;
            additions.push(p + ':' + v);
          });

          // Bake position for fixed/sticky/absolute elements — these are
          // often set by JavaScript (e.g. Elementor sticky headers) which
          // is stripped during snapshot.  Without this, positioned elements
          // fall back to static and create layout gaps / whitespace.
          if (isContainer && !existing.includes('position')) {
            const pos = cs.position;
            if (pos === 'fixed' || pos === 'sticky' || pos === 'absolute') {
              additions.push('position:' + pos);
              const top = cs.getPropertyValue('top');
              const left = cs.getPropertyValue('left');
              const right = cs.getPropertyValue('right');
              const bottom = cs.getPropertyValue('bottom');
              const zIndex = cs.getPropertyValue('z-index');
              if (top && top !== 'auto' && !existing.includes('top')) additions.push('top:' + top);
              if (left && left !== 'auto' && !existing.includes('left')) additions.push('left:' + left);
              if (right && right !== 'auto' && !existing.includes('right')) additions.push('right:' + right);
              if (bottom && bottom !== 'auto' && !existing.includes('bottom')) additions.push('bottom:' + bottom);
              if (zIndex && zIndex !== 'auto' && !existing.includes('z-index')) additions.push('z-index:' + zIndex);
              // Fixed/absolute elements need width to maintain their layout
              const w = cs.getPropertyValue('width');
              if (w && w !== 'auto' && !existing.includes('width')) additions.push('width:' + w);
            }
          }

          if (additions.length > 0) {
            el.setAttribute('style', existing + (existing ? ';' : '') + additions.join(';'));
            totalBaked++;
          }

          // Collect some samples for debugging
          if (samples.length < 8 && additions.length > 0) {
            samples.push({
              tag,
              classes: el.className?.toString?.()?.slice(0, 80) || '',
              propsAdded: additions.length,
              sample: additions.slice(0, 4).join('; ')
            });
          }
        });

        return { totalProcessed, totalSkipped, totalBaked, samples };
      })()
    `)
    console.log('[capture] STYLE BAKING:')
    console.log(`[capture]   Processed: ${bakeDebug.totalProcessed} | Skipped: ${bakeDebug.totalSkipped} | Baked: ${bakeDebug.totalBaked}`)
    console.log('[capture]   Samples:')
    bakeDebug.samples.forEach((s: any) => {
      console.log(`[capture]     <${s.tag}> .${s.classes.slice(0, 40)} → ${s.propsAdded} props: ${s.sample}`)
    })

    // ── Preserve functional page scripts ──
    // Extract ALL external script URLs except analytics/tracking/ads.
    // These are stored in a <meta> tag that survives script stripping.
    // The GrapesJS editor re-injects them into its canvas iframe so
    // interactive elements (chat widgets, sliders, tabs, menus, etc.)
    // work exactly as on the staging site.
    const preservedScripts: string[] = await captureWindow.webContents.executeJavaScript(`
      (() => {
        var scripts = Array.from(document.querySelectorAll('script[src]'));
        // Blacklist: analytics, tracking, ads, monitoring — non-functional
        var blacklist = /google-analytics\\.com|googletagmanager\\.com|gtag\\/js|connect\\.facebook\\.net|fbevents|hotjar\\.com|static\\.hotjar|mixpanel\\.com|cdn\\.segment\\.(com|io)|doubleclick\\.net|googlesyndication\\.com|adsbygoogle|pagead2|google\\.com\\/recaptcha|gstatic\\.com\\/recaptcha|nr-data\\.net|newrelic|sentry-cdn|sentry\\.io\\/sdk|bugsnag|datadoghq\\.com|clarity\\.ms|optimizely\\.com|crazyegg\\.com|mouseflow\\.com|smartlook|fullstory\\.com|heap-analytics|cdn\\.amplitude|plausible\\.io|matomo|piwik|clicky\\.com|statcounter\\.com|chartbeat\\.com|pardot\\.com|marketo\\.(net|com)|mc\\.yandex/i;
        var urls = scripts
          .map(function(s) { return s.src; })
          .filter(function(src) {
            if (!src) return false;
            return !blacklist.test(src);
          });
        if (urls.length > 0) {
          var meta = document.createElement('meta');
          meta.setAttribute('name', 'snapshot-preserved-scripts');
          meta.setAttribute('content', urls.join('|||'));
          document.head.appendChild(meta);
        }
        return urls;
      })()
    `)
    console.log('[capture] Preserved scripts:', preservedScripts.length)
    preservedScripts.forEach((u: string) => console.log('[capture]   ' + u))

    // Final cleanup — remove any cookie/overlay elements that re-appeared,
    // empty containers (chat widgets, stripped iframes, header spacers),
    // and other non-content elements that create whitespace.
    const finalCleanup: any = await captureWindow.webContents.executeJavaScript(`
      (() => {
        let removed = 0;
        const selectors = [
          '[class*="cookie"]', '[id*="cookie"]',
          '[class*="cky-"]', '[id*="cky-"]',
          '[class*="consent"]', '[id*="consent"]',
          '[class*="gdpr"]', '[id*="gdpr"]',
          '#onetrust-consent-sdk', '.onetrust-pc-dark-filter',
          '[class*="cookieyes"]', '[id*="cookieyes"]',
          '[class*="cc-window"]', '[class*="cc-banner"]',
          '[class*="osano"]',
          // Chat widgets & third-party overlays
          '[class*="tidio"]', '[id*="tidio"]',
          '[class*="intercom"]', '[id*="intercom"]',
          '[class*="tawk"]', '[id*="tawk"]',
          '[class*="livechat"]', '[id*="livechat"]',
          '[class*="drift"]', '[id*="drift"]',
          '[class*="hubspot"]', '[id*="hubspot"]',
          '[class*="crisp"]', '[id*="crisp"]',
          '[class*="zendesk"]', '[id*="zendesk"]',
        ];
        selectors.forEach(sel => {
          try { document.querySelectorAll(sel).forEach(el => {
            if (el.hasAttribute('data-widget-frozen') || el.closest('[data-widget-frozen]')) return;
            el.remove(); removed++;
          }); } catch {}
        });
        // Remove remaining fixed overlays (skip frozen widgets)
        document.querySelectorAll('*').forEach(el => {
          if (el.hasAttribute('data-widget-frozen') || el.closest('[data-widget-frozen]')) return;
          const s = getComputedStyle(el);
          if (s.position !== 'fixed' && s.position !== 'sticky') return;
          const z = parseInt(s.zIndex, 10);
          if (z > 9000) { el.remove(); removed++; }
        });

        // Remove empty iframes (chat widgets, tracking pixels stripped of src)
        document.querySelectorAll('iframe').forEach(f => {
          if (!f.src || f.src === 'about:blank' || f.src === '') {
            f.remove(); removed++;
          }
        });

        // Collapse visually empty leaf containers that take up space.
        // These are typically JS-widget containers, header spacers,
        // notification bars, etc. whose content was JS-generated and
        // is now gone.  Only target leaf-level empty elements (no
        // child elements) to avoid collapsing legitimate flex/grid
        // parents whose children are positioned elsewhere.
        document.querySelectorAll('div, section, aside').forEach(el => {
          if (el.hasAttribute('data-widget-frozen') || el.closest('[data-widget-frozen]')) return;
          // Must be a leaf — no child elements at all
          if (el.children.length > 0) return;
          // Skip elements with text content
          const text = (el.textContent || '').trim();
          if (text.length > 0) return;
          // Skip elements with meaningful background
          const cs = getComputedStyle(el);
          if (cs.backgroundImage && cs.backgroundImage !== 'none') return;
          // This empty leaf takes up visual space — collapse it
          const rect = el.getBoundingClientRect();
          if (rect.height > 20 && rect.width > 50) {
            el.style.display = 'none';
            removed++;
          }
        });

        // Final check for any remaining consent elements
        const stillRemaining = [];
        document.querySelectorAll('*').forEach(el => {
          const text = (el.innerText || '').toLowerCase();
          if (text.includes('we value your privacy')) {
            stillRemaining.push({
              tag: el.tagName, id: el.id,
              classes: el.className?.toString?.()?.slice(0, 100) || '',
              position: getComputedStyle(el).position,
              parentTag: el.parentElement?.tagName || 'none',
              parentClasses: el.parentElement?.className?.toString?.()?.slice(0, 60) || ''
            });
          }
        });

        return { removed, stillRemaining };
      })()
    `)
    console.log('[capture] FINAL CLEANUP:')
    console.log(`[capture]   Removed ${finalCleanup.removed} additional elements`)
    if (finalCleanup.stillRemaining.length > 0) {
      console.log(`[capture]   ⚠ STILL REMAINING consent elements: ${finalCleanup.stillRemaining.length}`)
      finalCleanup.stillRemaining.forEach((r: any) => {
        console.log(`[capture]     ${r.tag}#${r.id} .${r.classes.slice(0, 50)} pos=${r.position} parent=${r.parentTag}.${r.parentClasses}`)
      })
    }

    const html: string = await captureWindow.webContents.executeJavaScript(
      'document.documentElement.outerHTML'
    )

    console.log(`[capture] Final HTML size: ${(html.length / 1024).toFixed(1)} KB`)
    console.log('[capture] Done!')

    return html
  } finally {
    if (!captureWindow.isDestroyed()) {
      captureWindow.close()
    }
  }
}
