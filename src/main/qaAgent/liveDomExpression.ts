// Scripts evaluated inside the page being captured. They are plain strings (not
// serialised functions) so a bundler cannot inject helpers that would break them in the
// page. Nothing here throws: problems are returned as warnings, because a QA capture of a
// slightly unruly page is more useful than a refusal.

/**
 * Prepares the page once: hides admin chrome and cookie banners, loads lazy images,
 * scrolls to trigger reveal-on-scroll, finishes finite animations, and indexes the
 * fixed and sticky elements so each capture screen can show them correctly.
 */
export const PREPARE_EXPRESSION = String.raw`(async () => {
  const warnings = [];
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const frame = () => Promise.race([new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))), wait(120)]);
  const guard = async (label, task) => { try { await task(); } catch (error) { warnings.push(label + ': ' + ((error && error.message) || error)); } };
  const state = (window.__qaCapture = { fixed: [], sticky: [], seen: new WeakSet() });

  await guard('page styles', async () => {
    const style = document.createElement('style');
    style.id = '__qaCaptureStyle';
    style.textContent = [
      '*,*::before,*::after{transition:none!important;caret-color:transparent!important}',
      'html{scroll-behavior:auto!important}',
      '#wpadminbar{display:none!important}',
      'html{margin-top:0!important}',
      '#cookie-notice,.cookie-notice,#onetrust-consent-sdk,.cc-window,#cmplz-cookiebanner,.cookie-banner,.cli-modal-backdrop,#cliModal,.cookie-law-info-bar,.grecaptcha-badge{display:none!important}',
    ].join('');
    document.head.appendChild(style);
    document.body.classList.remove('admin-bar');
    document.documentElement.classList.remove('wp-toolbar');
  });

  await guard('lazy images', async () => {
    document.querySelectorAll('img, source, iframe').forEach((el) => {
      try { el.setAttribute('loading', 'eager'); } catch (e) {}
      const dataSrc = el.getAttribute('data-src') || el.getAttribute('data-lazy-src');
      if (dataSrc) el.setAttribute('src', dataSrc);
      const dataSrcset = el.getAttribute('data-srcset');
      if (dataSrcset) el.setAttribute('srcset', dataSrcset);
    });
    document.querySelectorAll('[data-bg], [data-background]').forEach((el) => {
      const bg = el.getAttribute('data-bg') || el.getAttribute('data-background');
      if (bg) el.style.backgroundImage = 'url("' + bg + '")';
    });
  });

  await guard('scroll pass', async () => {
    const deadline = Date.now() + 20000;
    const step = Math.max(200, Math.round(innerHeight * 0.75));
    for (let y = 0; ; y += step) {
      if (Date.now() > deadline) { warnings.push('The scroll pass stopped after 20 seconds; content further down may not have loaded.'); break; }
      if (y > 20000) { warnings.push('The scroll pass stopped at 20,000px.'); break; }
      window.scrollTo(0, y);
      await frame();
      await wait(120);
      if (y + innerHeight >= document.documentElement.scrollHeight) break;
    }
    window.scrollTo(0, 0);
  });

  await guard('fonts', async () => {
    if (document.fonts && document.fonts.ready) await Promise.race([document.fonts.ready, wait(5000)]);
  });

  await guard('reveal animations', async () => {
    document.querySelectorAll('[data-aos]').forEach((el) => el.classList.add('aos-animate'));
    document.querySelectorAll('.elementor-invisible').forEach((el) => el.classList.remove('elementor-invisible'));
    document.querySelectorAll('.wow').forEach((el) => { el.style.visibility = 'visible'; el.style.animationName = 'none'; });
    for (const animation of document.getAnimations()) {
      try {
        const timing = animation.effect && animation.effect.getComputedTiming ? animation.effect.getComputedTiming() : null;
        if (timing && Number.isFinite(timing.endTime)) animation.finish(); else animation.pause();
      } catch (e) {}
    }
    document.querySelectorAll('video').forEach((video) => { try { video.pause(); } catch (e) {} });
    await wait(150);
  });

  await guard('images', async () => {
    const images = Array.from(document.images);
    const deadline = Date.now() + 10000;
    await Promise.allSettled(images.map((img) => (img.complete ? Promise.resolve() : Promise.race([img.decode(), wait(Math.max(0, deadline - Date.now()))]))));
    const broken = images.filter((img) => img.complete && img.naturalWidth === 0 && (img.currentSrc || img.src)).length;
    if (broken) warnings.push(broken + ' image(s) did not load.');
  });

  const hiddenOverlays = [];
  // Sticky elements render once, in the page flow. Fixed elements are shown only on the
  // screens where a visitor would see them: top-anchored on the first, bottom-anchored on the last.
  state.scan = () => {
    let added = 0;
    const all = document.body ? document.body.querySelectorAll('*') : [];
    for (const el of all) {
      if (state.seen.has(el)) continue;
      const cs = getComputedStyle(el);
      if (cs.position === 'sticky') {
        state.seen.add(el);
        el.style.setProperty('position', 'relative', 'important');
        el.style.setProperty('top', 'auto', 'important');
        el.style.setProperty('bottom', 'auto', 'important');
        state.sticky.push(el);
        added++;
      } else if (cs.position === 'fixed') {
        state.seen.add(el);
        const rect = el.getBoundingClientRect();
        const covers = rect.width * rect.height >= 0.8 * innerWidth * innerHeight;
        const bottom = cs.bottom !== 'auto' && (cs.top === 'auto' || rect.top >= innerHeight / 2);
        state.fixed.push({ el, bottom, covers, visibility: el.style.getPropertyValue('visibility'), priority: el.style.getPropertyPriority('visibility') });
        if (covers) hiddenOverlays.push(el.tagName.toLowerCase() + (el.id ? '#' + el.id : ''));
        added++;
      }
    }
    return added;
  };
  state.apply = (first, last) => {
    for (const item of state.fixed) {
      const show = item.covers ? false : item.bottom ? last : first;
      if (show) {
        if (item.visibility) item.el.style.setProperty('visibility', item.visibility, item.priority || ''); else item.el.style.removeProperty('visibility');
      } else {
        item.el.style.setProperty('visibility', 'hidden', 'important');
      }
    }
  };
  state.showAll = () => {
    for (const item of state.fixed) {
      if (item.visibility) item.el.style.setProperty('visibility', item.visibility, item.priority || ''); else item.el.style.removeProperty('visibility');
    }
  };
  state.tile = async (y, first, last) => {
    const root = document.documentElement;
    root.style.setProperty('scroll-behavior', 'auto', 'important');
    window.scrollTo(0, y);
    root.scrollTop = y;
    await frame();
    await wait(60);
    state.scan();
    state.apply(first, last);
    await wait(30);
    const scroller = document.scrollingElement || root;
    return {
      y: Math.round(scroller.scrollTop),
      scrollHeight: Math.ceil(Math.max(scroller.scrollHeight, root.scrollHeight, document.body ? document.body.scrollHeight : 0)),
      maxScroll: Math.ceil(Math.max(0, scroller.scrollHeight - scroller.clientHeight)),
      clientWidth: root.clientWidth,
    };
  };

  await guard('fixed elements', async () => { state.scan(); });
  if (hiddenOverlays.length) warnings.push('Hid full-screen overlay(s): ' + hiddenOverlays.slice(0, 5).join(', ') + '.');
  window.scrollTo(0, 0);
  await frame();
  return { warnings, fixed: state.fixed.length, sticky: state.sticky.length };
})()`

/** Measures the page after preparation. */
export const MEASURE_EXPRESSION = String.raw`(() => {
  const root = document.documentElement;
  const body = document.body;
  const scroller = document.scrollingElement || root;
  const clientWidth = root.clientWidth;
  const scrollWidth = Math.ceil(Math.max(root.scrollWidth, body ? body.scrollWidth : 0));
  const viewportHeight = Math.max(1, Math.ceil(scroller.clientHeight || innerHeight));
  const height = Math.ceil(Math.max(scroller.scrollHeight, root.scrollHeight, body ? body.scrollHeight : 0, viewportHeight));
  const scrollRange = Math.ceil(Math.max(0, scroller.scrollHeight - scroller.clientHeight, root.scrollHeight - root.clientHeight));
  const culprits = [];
  if (scrollWidth > clientWidth + 1 && body) {
    for (const el of body.querySelectorAll('*')) {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.right > clientWidth + 1 && getComputedStyle(el).position !== 'fixed') {
        culprits.push(el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/)[0] : '') + ' (right edge ' + Math.round(rect.right) + 'px)');
        if (culprits.length >= 5) break;
      }
    }
  }
  return { clientWidth, scrollWidth, viewportHeight, height, scrollRange, culprits, innerWidth };
})()`

/**
 * Reads what the page looks like right now (scroll position 0, fixed elements visible):
 * a list of elements with their boxes and computed values, the top-level content blocks
 * that become sections, and a few page facts.
 */
export const VALUES_EXPRESSION = String.raw`(() => {
  const root = document.documentElement;
  const body = document.body;
  const compact = (value) => String(value || '').trim().replace(/\s+/g, ' ');
  const NODE_CAP = 2500;
  const TEXT_CAP = 160;
  const LEAF = 'h1,h2,h3,h4,h5,h6,p,a,button,label,li,span,dt,dd,summary,figcaption,th,td';
  const SELECTORS = 'h1,h2,h3,h4,h5,h6,p,a,button,label,li,span,div,dt,dd,summary,figcaption,th,td,img,input,textarea,select,section,article,header,footer,nav,main,aside,form,ul,ol';
  const pageHeight = Math.ceil(Math.max(root.scrollHeight, body ? body.scrollHeight : 0));
  const pageWidth = root.clientWidth;

  const ownText = (el) => compact(Array.from(el.childNodes).filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent || '').join(' '));
  const textOf = (el) => {
    const accessible = compact(el.getAttribute('alt') || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || '');
    if (el.matches('img,input,textarea,select')) return accessible;
    if (el.matches(LEAF)) return compact(el.innerText || el.textContent || accessible);
    const own = ownText(el);
    return own || accessible;
  };
  const sideValues = (cs, prefix, suffix) => ['top', 'right', 'bottom', 'left'].map((side) => Math.round(parseFloat(cs[prefix + '-' + side + suffix]) || 0));
  const uniformOrList = (values) => (values.every((v) => v === values[0]) ? String(values[0]) : values.join(' '));
  const kindOfBackground = (cs) => {
    const image = cs.backgroundImage;
    if (!image || image === 'none') return 'none';
    return image.indexOf('gradient') >= 0 ? (image.indexOf('url(') >= 0 ? 'url+gradient' : 'gradient') : 'url';
  };
  const hasPaint = (cs) => {
    const bg = cs.backgroundColor;
    const solid = bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)';
    const border = ['top', 'right', 'bottom', 'left'].some((s) => parseFloat(cs['border-' + s + '-width']) > 0 && cs['border-' + s + '-style'] !== 'none');
    return solid || kindOfBackground(cs) !== 'none' || border || cs.boxShadow !== 'none' || parseFloat(cs.borderTopLeftRadius) > 0;
  };
  const pathFor = (el) => {
    const parts = [];
    let current = el;
    while (current && current !== root && parts.length < 8) {
      const index = Array.from(current.parentElement ? current.parentElement.children : []).indexOf(current) + 1;
      parts.unshift(current.tagName.toLowerCase() + ':nth-child(' + index + ')');
      current = current.parentElement;
    }
    return parts.join(' > ');
  };
  const visible = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
    if (Number(cs.opacity) === 0) return false;
    return !el.closest('[hidden],[aria-hidden="true"]');
  };

  const nodes = [];
  let truncatedNodes = false;
  for (const el of document.querySelectorAll(SELECTORS)) {
    if (nodes.length >= NODE_CAP) { truncatedNodes = true; break; }
    if (!visible(el)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;
    const cs = getComputedStyle(el);
    const tag = el.tagName.toLowerCase();
    const text = textOf(el);
    const media = tag === 'img' || tag === 'input' || tag === 'textarea' || tag === 'select';
    const interactive = tag === 'a' || tag === 'button';
    const styledBox = rect.width >= 40 && rect.height >= 20 && hasPaint(cs);
    if (!text && !media && !interactive && !styledBox) continue;
    const positioned = cs.position === 'fixed' || cs.position === 'sticky';
    const node = {
      tag,
      text: text.slice(0, TEXT_CAP),
      rect: { x: Math.round(rect.left + scrollX), y: Math.round(rect.top + scrollY), width: Math.round(rect.width), height: Math.round(rect.height) },
      path: pathFor(el),
      styles: {
        fontFamily: cs.fontFamily, fontSize: cs.fontSize, fontWeight: cs.fontWeight, lineHeight: cs.lineHeight,
        letterSpacing: cs.letterSpacing, color: cs.color, textAlign: cs.textAlign, textTransform: cs.textTransform,
        textDecoration: cs.textDecorationLine, display: cs.display, position: cs.position, opacity: cs.opacity,
        backgroundColor: cs.backgroundColor, backgroundImage: kindOfBackground(cs),
        padding: uniformOrList(sideValues(cs, 'padding', '')), margin: uniformOrList(sideValues(cs, 'margin', '')),
        gap: cs.rowGap === cs.columnGap ? cs.rowGap : cs.rowGap + ' ' + cs.columnGap,
        border: uniformOrList(sideValues(cs, 'border', '-width')) + ' ' + cs.borderTopStyle + ' ' + cs.borderTopColor,
        borderRadius: cs.borderTopLeftRadius, shadow: cs.boxShadow !== 'none' ? 'yes' : 'none',
        flex: cs.display.indexOf('flex') >= 0 ? cs.flexDirection + '/' + cs.justifyContent + '/' + cs.alignItems : '',
      },
    };
    if (tag === 'img') { node.src = el.currentSrc || el.src || ''; node.natural = el.naturalWidth + 'x' + el.naturalHeight; node.objectFit = cs.objectFit; }
    if (positioned) node.positioned = cs.position;
    nodes.push(node);
  }

  const labelOf = (el) => {
    const heading = el.querySelector('h1,h2,h3');
    return compact((heading && heading.textContent) || el.getAttribute('aria-label') || el.id || (typeof el.className === 'string' ? el.className.trim().split(/\s+/)[0] : '') || el.tagName.toLowerCase());
  };
  const selectorOf = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/)[0] : '');
  const SKIP = /^(SCRIPT|STYLE|LINK|NOSCRIPT|TEMPLATE|IFRAME)$/;
  const inFlowChildren = (el) => Array.from(el.children).filter((child) => {
    if (SKIP.test(child.tagName)) return false;
    const cs = getComputedStyle(child);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    if (cs.position === 'fixed' || cs.position === 'absolute') return false;
    const rect = child.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
  const toBlock = (el) => {
    const rect = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const solid = cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent';
    return { tag: el.tagName.toLowerCase(), selector: selectorOf(el), top: rect.top + scrollY, height: rect.height, label: labelOf(el), bg: solid ? cs.backgroundColor : '', bgImage: kindOfBackground(cs), bgFixed: cs.backgroundAttachment === 'fixed' };
  };
  const blocks = [];
  const addBlocks = (el, depth) => {
    const rect = el.getBoundingClientRect();
    const children = inFlowChildren(el);
    // A block taller than about two screens that is made of several parts is split into its parts.
    if (depth < 3 && rect.height > innerHeight * 2.2 && children.length >= 2) { children.forEach((child) => addBlocks(child, depth + 1)); return; }
    blocks.push(toBlock(el));
  };
  const elementorRoots = Array.from(document.querySelectorAll('[data-elementor-type]')).filter((el) => !(el.parentElement && el.parentElement.closest('[data-elementor-type]')));
  if (elementorRoots.length) {
    elementorRoots.forEach((rootEl) => inFlowChildren(rootEl).forEach((child) => addBlocks(child, 0)));
  } else if (body) {
    let container = body;
    for (let i = 0; i < 6; i++) {
      const children = inFlowChildren(container);
      const containerHeight = container.getBoundingClientRect().height;
      if (children.length === 1 && children[0].getBoundingClientRect().height >= 0.6 * containerHeight) container = children[0]; else break;
    }
    inFlowChildren(container).forEach((child) => addBlocks(child, 0));
  }

  const fontsFailed = [];
  if (document.fonts) { document.fonts.forEach((face) => { if (face.status === 'error') fontsFailed.push(face.family); }); }
  const viewportMeta = document.querySelector('meta[name="viewport"]');
  return {
    nodes, truncatedNodes, blocks, pageWidth, pageHeight,
    title: document.title || '', lang: root.lang || '',
    viewportMeta: viewportMeta ? viewportMeta.getAttribute('content') || '' : '',
    fontsFailed: Array.from(new Set(fontsFailed)).slice(0, 10),
    bodyClass: body ? String(body.className || '').slice(0, 200) : '',
    is404: !!(body && (body.classList.contains('error404') || body.classList.contains('page-not-found'))),
  };
})()`
