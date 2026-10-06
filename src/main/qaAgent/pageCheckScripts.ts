// Scripts for the page checks (pageCheckTools.ts), run inside the page open in the agent's browser.
// Each is a function source string called with JSON arguments. They only read the page, except that
// an element they report gets a data-parity-ref (e12), so the agent can scroll to it, click it or
// inspect it again. The contrast check scrolls through the page and puts the scroll back after.

const PAGE_HELPERS = `
  const clean = (text, max = 80) => String(text || '').replace(/\\s+/g, ' ').trim().slice(0, max);
  const shown = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    return el.checkVisibility ? el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) : getComputedStyle(el).visibility !== 'hidden';
  };
  const refOf = (el) => {
    window.__parityRefCounter = window.__parityRefCounter || 0;
    if (!el.dataset.parityRef) el.dataset.parityRef = 'e' + (++window.__parityRefCounter);
    return el.dataset.parityRef;
  };
  const boxOf = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), width: Math.round(r.width), height: Math.round(r.height) }; };
  const nameOf = (el) => {
    let name = el.tagName.toLowerCase();
    if (el.id) name += '#' + el.id;
    const classes = typeof el.className === 'string' ? el.className.trim().split(/\\s+/).filter((c) => c && !/^(elementor-element-[0-9a-f]+|e-con-[a-z]+)$/.test(c)).slice(0, 2) : [];
    return name + (classes.length ? '.' + classes.join('.') : '');
  };
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'OPTION', 'TITLE', 'svg', 'SVG']);
  /** Elements that hold visible text directly, in page order. */
  const textElements = (limit) => {
    const out = [], seen = new Set();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.nodeValue.trim().length > 1 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT) });
    while (walker.nextNode() && out.length < limit) {
      const el = walker.currentNode.parentElement;
      if (!el || seen.has(el) || SKIP.has(el.tagName)) continue;
      seen.add(el);
      if (shown(el)) out.push(el);
    }
    return out;
  };
  const paint = document.createElement('canvas'); paint.width = paint.height = 1;
  const pen = paint.getContext('2d', { willReadFrequently: true });
  const colorCache = new Map();
  /** Any CSS colour as [r, g, b, alpha 0-1], whatever syntax the page used (rgb, oklch, color()). */
  const rgba = (color) => {
    if (colorCache.has(color)) return colorCache.get(color);
    let out = [0, 0, 0, 0];
    if (color && color !== 'transparent') {
      pen.clearRect(0, 0, 1, 1); pen.fillStyle = '#000'; pen.fillStyle = color; pen.fillRect(0, 0, 1, 1);
      const d = pen.getImageData(0, 0, 1, 1).data; out = [d[0], d[1], d[2], d[3] / 255];
    }
    colorCache.set(color, out);
    return out;
  };
  const hex = (c) => '#' + c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('') + (c[3] < 0.99 ? ' at ' + Math.round(c[3] * 100) + '%' : '');
  const blend = (top, bottom) => {
    const a = top[3] + bottom[3] * (1 - top[3]);
    if (!a) return [255, 255, 255, 0];
    return [0, 1, 2].map((i) => (top[i] * top[3] + bottom[i] * bottom[3] * (1 - top[3])) / a).concat(a);
  };
  const luminance = (c) => { const [r, g, b] = c.slice(0, 3).map((v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const contrast = (a, b) => { const la = luminance(a), lb = luminance(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); };
  const firstFamily = (list) => clean(String(list || '').split(',')[0].replace(/["']/g, ''), 60);
  const GENERIC = /^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-[a-z-]+|-apple-system|blinkmacsystemfont|math|emoji)$/i;
  const fontCache = new Map();
  /** Whether a font family really renders, or the browser fell back to another font. */
  const fontRenders = (family) => {
    if (!family || GENERIC.test(family)) return true;
    if (fontCache.has(family)) return fontCache.get(family);
    const sample = 'mmmmmmmmmmlli1WQ@#&gyAB';
    const width = (font) => { pen.font = '72px ' + font; return pen.measureText(sample).width; };
    const quoted = '"' + family.replace(/"/g, '') + '"';
    const renders = width(quoted + ', monospace') !== width('monospace') || width(quoted + ', serif') !== width('serif');
    fontCache.set(family, renders);
    return renders;
  };
  const weightOf = (s) => Number(s.fontWeight) || (s.fontWeight === 'bold' ? 700 : 400);
`

/** Finds elements by ref, CSS selector or the text they show, and reads their box and styles. */
export const INSPECT_SCRIPT = `(query) => {${PAGE_HELPERS}
  let found = [];
  if (query.ref) {
    const el = document.querySelector('[data-parity-ref="' + query.ref + '"]');
    if (el) found = [el];
  } else if (query.selector) {
    try { found = [...document.querySelectorAll(query.selector)]; } catch (e) { return { error: 'That is not a valid CSS selector.' }; }
  } else if (query.text) {
    const needle = clean(query.text, 200).toLowerCase();
    const holders = new Set();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) { const node = walker.currentNode; if (node.nodeValue.toLowerCase().includes(needle) && node.parentElement && !SKIP.has(node.parentElement.tagName)) holders.add(node.parentElement); }
    if (!holders.size) {
      // The text may be split over several elements ("Book <b>now</b>"): take the smallest element that holds all of it.
      const all = [...document.body.querySelectorAll('*')].filter((el) => !SKIP.has(el.tagName) && clean(el.textContent, 100000).toLowerCase().includes(needle));
      all.filter((el) => ![...el.children].some((child) => clean(child.textContent, 100000).toLowerCase().includes(needle))).forEach((el) => holders.add(el));
    }
    found = [...holders];
  }
  const visibleOnes = found.filter(shown);
  const picked = (visibleOnes.length ? visibleOnes : found).slice(0, query.limit || 6);
  const side = (s, prop) => { const v = ['Top', 'Right', 'Bottom', 'Left'].map((k) => s[prop + k]); return v.every((x) => x === v[0]) ? v[0] : v.join(' '); };
  return {
    total: found.length, visible: visibleOnes.length,
    items: picked.map((el) => {
      const s = getComputedStyle(el);
      const family = firstFamily(s.fontFamily);
      const item = {
        ref: refOf(el), name: nameOf(el), text: clean(el.innerText || el.getAttribute('aria-label') || el.getAttribute('alt') || '', 140), shown: shown(el), box: boxOf(el),
        font: weightOf(s) + ' ' + s.fontSize + '/' + s.lineHeight + ' ' + family + (s.fontStyle === 'italic' ? ' italic' : ''), fontStack: clean(s.fontFamily, 160), fontRenders: fontRenders(family),
        color: hex(rgba(s.color)), background: rgba(s.backgroundColor)[3] > 0 ? hex(rgba(s.backgroundColor)) : '', backgroundImage: s.backgroundImage !== 'none' ? clean(s.backgroundImage, 120) : '',
        margin: side(s, 'margin'), padding: side(s, 'padding'), display: s.display, position: s.position,
      };
      if (s.letterSpacing !== 'normal') item.letterSpacing = s.letterSpacing;
      if (s.textTransform !== 'none') item.textTransform = s.textTransform;
      if (s.textAlign !== 'start') item.textAlign = s.textAlign;
      if (/flex|grid/.test(s.display) && s.gap !== 'normal') item.gap = s.gap;
      if (s.borderTopWidth !== '0px' && s.borderTopStyle !== 'none') item.border = s.borderTopWidth + ' ' + s.borderTopStyle + ' ' + hex(rgba(s.borderTopColor));
      if (s.borderRadius !== '0px') item.radius = s.borderRadius;
      if (s.boxShadow !== 'none') item.shadow = clean(s.boxShadow, 80);
      if (Number(s.opacity) < 1) item.opacity = s.opacity;
      if (s.maxWidth !== 'none') item.maxWidth = s.maxWidth;
      if (el.tagName === 'IMG') item.image = { src: clean(el.currentSrc || el.src, 200), natural: el.naturalWidth + 'x' + el.naturalHeight, alt: el.hasAttribute('alt') ? el.getAttribute('alt') : null, fit: s.objectFit };
      if (el.tagName === 'A') item.href = clean(el.getAttribute('href'), 200);
      return item;
    }),
  };
}`

/** WCAG contrast of every visible text against what is painted behind it. */
export const CONTRAST_SCRIPT = `(limit) => {${PAGE_HELPERS}
  const MEDIA = new Set(['img', 'video', 'canvas', 'picture', 'iframe', 'svg', 'object', 'embed']);
  const startY = scrollY;
  const rows = textElements(1500).map((el) => ({ el, top: el.getBoundingClientRect().top + scrollY })).sort((a, b) => a.top - b.top);
  const groups = new Map();
  let checked = 0, overImage = 0, covered = 0;
  try {
    for (const row of rows) {
      let r = row.el.getBoundingClientRect();
      // A third of the way down the screen, clear of a sticky header.
      if (r.top < innerHeight / 4 || r.bottom > innerHeight) { window.scrollTo({ top: Math.max(0, row.top - innerHeight / 3), behavior: 'instant' }); r = row.el.getBoundingClientRect(); }
      const s = getComputedStyle(row.el);
      const ink = rgba(s.webkitTextFillColor && s.webkitTextFillColor !== s.color ? s.webkitTextFillColor : s.color);
      if (ink[3] === 0) continue; // gradient or clipped text: nothing to measure
      const first = row.el.getClientRects()[0] || r;
      const x = Math.min(innerWidth - 1, Math.max(0, first.left + Math.min(first.width / 2, 24)));
      const y = Math.min(innerHeight - 1, Math.max(0, first.top + first.height / 2));
      const stack = document.elementsFromPoint(x, y);
      const at = stack.indexOf(row.el);
      if (at < 0) { covered++; continue; } // a sticky header or popup is on top of it here
      let image = false;
      const layers = [];
      for (const node of stack.slice(at)) {
        if (node !== row.el && MEDIA.has(node.localName)) { image = true; break; }
        const ns = getComputedStyle(node);
        if (ns.backgroundImage && ns.backgroundImage !== 'none') { image = true; break; }
        const c = rgba(ns.backgroundColor);
        if (c[3] > 0) { layers.push(c); if (c[3] >= 0.99) break; }
      }
      if (image) { overImage++; continue; }
      let back = [255, 255, 255, 1];
      for (let i = layers.length - 1; i >= 0; i--) back = blend(layers[i], back);
      const fore = blend(ink, back);
      const ratio = contrast(fore, back);
      checked++;
      const size = parseFloat(s.fontSize), weight = weightOf(s);
      const large = size >= 24 || (size >= 18.66 && weight >= 700);
      const needed = large ? 3 : 4.5;
      if (ratio >= needed) continue;
      const key = hex(fore) + '|' + hex(back) + '|' + size + '|' + weight;
      let group = groups.get(key);
      if (!group) { group = { text: hex(fore), background: hex(back), ratio: Math.round(ratio * 100) / 100, needed, size: Math.round(size * 10) / 10, weight, count: 0, examples: [], ref: refOf(row.el), box: boxOf(row.el) }; groups.set(key, group); }
      group.count++;
      if (group.examples.length < 2) group.examples.push(clean(row.el.innerText || row.el.textContent, 60));
    }
  } finally { window.scrollTo({ top: startY, behavior: 'instant' }); }
  const failing = [...groups.values()].sort((a, b) => a.ratio - b.ratio);
  return { checked, failingElements: failing.reduce((n, g) => n + g.count, 0), groups: failing.slice(0, limit), moreGroups: Math.max(0, failing.length - limit), overImage, covered };
}`

/** Layout problems at the current width: sideways overflow, small text, small tap targets, distorted images, cut-off and overlapping text. */
export const LAYOUT_SCRIPT = `(options) => {${PAGE_HELPERS}
  const root = document.documentElement;
  const vw = root.clientWidth;
  const clipsX = (s) => /hidden|clip|auto|scroll/.test(s.overflowX);
  const pageClips = /hidden|clip/.test(getComputedStyle(root).overflowX) || /hidden|clip/.test(getComputedStyle(document.body).overflowX);
  const pageWidth = Math.max(root.scrollWidth, document.body.scrollWidth);
  const out = { viewportWidth: vw, pageWidth, scrollsSideways: pageWidth > vw + 1 && !pageClips, pageClipsSideways: pageClips };

  // Content past the right edge, outermost element only, unless a slider or other box clips it, or it is fixed (an off-canvas menu).
  const sticking = [];
  for (const el of [...document.body.querySelectorAll('*')].slice(0, 8000)) {
    if (sticking.length >= 10) break;
    if (SKIP.has(el.tagName)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || r.right <= vw + 2) continue;
    if (sticking.some((item) => item.el.contains(el))) continue;
    let hidden = false;
    for (let node = el; node && node !== document.body; node = node.parentElement) {
      const s = getComputedStyle(node);
      if (s.position === 'fixed' || (node !== el && clipsX(s))) { hidden = true; break; }
    }
    if (hidden || !shown(el)) continue;
    sticking.push({ el, ref: refOf(el), name: nameOf(el), text: clean(el.innerText, 60), box: boxOf(el), past: Math.round(r.right - vw) });
  }
  out.pastRightEdge = sticking.map(({ el, ...rest }) => rest);

  const texts = textElements(2500);
  // Text smaller than 12px.
  const small = new Map();
  for (const el of texts) {
    const size = parseFloat(getComputedStyle(el).fontSize);
    if (size >= 12) continue;
    const key = Math.round(size * 10) / 10;
    const group = small.get(key) || { size: key, count: 0, examples: [], ref: refOf(el) };
    group.count++;
    if (group.examples.length < 3) group.examples.push(clean(el.innerText, 40));
    small.set(key, group);
  }
  out.smallText = [...small.values()].sort((a, b) => a.size - b.size);

  // Tap targets under 24px on touch screens (WCAG 2.5.8). Links inside a sentence are exempt.
  if (options.touch) {
    const tiny = [];
    let underRecommended = 0, more = 0;
    const targets = document.querySelectorAll('a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=tab], [role=checkbox], [role=radio]');
    for (const el of targets) {
      if (!shown(el)) continue;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      const inSentence = el.tagName === 'A' && s.display === 'inline' && el.parentElement && clean(el.parentElement.innerText, 100000).length > clean(el.innerText, 100000).length + 20;
      if (inSentence) continue;
      if (r.width < 24 || r.height < 24) { if (tiny.length < 12) tiny.push({ ref: refOf(el), name: clean(el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || el.value || nameOf(el), 50), width: Math.round(r.width), height: Math.round(r.height) }); else more++; }
      else if (r.width < 44 || r.height < 44) underRecommended++;
    }
    out.smallTapTargets = tiny;
    out.smallTapTargetsMore = more;
    out.tapTargetsUnder44 = underRecommended;
  }

  // Images shown stretched, blown up past their own size, or far larger than shown.
  const images = [];
  for (const img of document.images) {
    if (images.length >= 15 || !img.naturalWidth || !shown(img)) continue;
    const r = img.getBoundingClientRect();
    const s = getComputedStyle(img);
    const problems = [];
    const ratio = (r.width / r.height) / (img.naturalWidth / img.naturalHeight);
    if ((s.objectFit === 'fill' || !s.objectFit) && Math.abs(ratio - 1) > 0.06 && r.width > 40 && r.height > 40) problems.push(ratio > 1 ? 'stretched wide' : 'squashed (stretched tall)');
    if (r.width > img.naturalWidth * 1.25 && r.width > 120) problems.push('blown up to ' + Math.round(r.width / img.naturalWidth * 100) + '% of its own size, so blurry');
    if (img.naturalWidth > r.width * 2.5 && img.naturalWidth > 1200) problems.push('file is ' + img.naturalWidth + 'px wide for ' + Math.round(r.width) + 'px shown');
    if (problems.length) images.push({ ref: refOf(img), src: clean(img.currentSrc || img.src, 160), natural: img.naturalWidth + 'x' + img.naturalHeight, shown: Math.round(r.width) + 'x' + Math.round(r.height), problems });
  }
  out.images = images;

  // Text cut off by its box.
  const clipped = [];
  for (const el of texts) {
    if (clipped.length >= 10) break;
    const s = getComputedStyle(el);
    if (!/hidden|clip/.test(s.overflow + ' ' + s.overflowX + ' ' + s.overflowY)) continue;
    const wide = el.scrollWidth > el.clientWidth + 2, tall = el.scrollHeight > el.clientHeight + 2;
    if (!wide && !tall) continue;
    clipped.push({ ref: refOf(el), text: clean(el.innerText, 70), how: s.textOverflow === 'ellipsis' ? 'ends in …' : s.webkitLineClamp && s.webkitLineClamp !== 'none' ? 'clamped to ' + s.webkitLineClamp + ' lines' : wide ? 'cut off at the side' : 'cut off at the bottom' });
  }
  out.cutOffText = clipped;

  // Text over other text.
  const blocks = texts.slice(0, 900).map((el) => ({ el, r: el.getBoundingClientRect() })).filter((b) => b.r.width > 4 && b.r.height > 4).sort((a, b) => a.r.top - b.r.top);
  const overlaps = [];
  for (let i = 0; i < blocks.length && overlaps.length < 8; i++) {
    const a = blocks[i];
    for (let j = i + 1; j < blocks.length && blocks[j].r.top < a.r.bottom; j++) {
      const b = blocks[j];
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left), h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
      if (w <= 2 || h <= 2) continue;
      const share = (w * h) / Math.min(a.r.width * a.r.height, b.r.width * b.r.height);
      if (share < 0.25) continue;
      overlaps.push({ refs: [refOf(a.el), refOf(b.el)], texts: [clean(a.el.innerText, 40), clean(b.el.innerText, 40)], y: Math.round(Math.max(a.r.top, b.r.top) + scrollY) });
      if (overlaps.length >= 8) break;
    }
  }
  out.overlappingText = overlaps;
  return out;
}`

/** Which text styles, fonts and colours the page uses, grouped by kind of text, to spot inconsistencies. */
export const STYLES_SCRIPT = `() => {${PAGE_HELPERS}
  const kindOf = (el) => {
    const heading = el.closest('h1, h2, h3, h4, h5, h6');
    if (heading) return heading.tagName;
    if (el.closest('button, [role=button], input[type=submit], .elementor-button, .wp-block-button__link, .wp-element-button, .btn, .button')) return 'Button';
    if (el.closest('nav, [role=navigation]')) return 'Menu';
    if (el.closest('footer')) return 'Footer text';
    if (el.closest('a')) return 'Link';
    if (el.closest('label, input, select, textarea')) return 'Form';
    return 'Body text';
  };
  const kinds = {}, families = new Map(), colors = new Map(), backgrounds = new Map();
  for (const el of textElements(3000)) {
    const s = getComputedStyle(el);
    const family = firstFamily(s.fontFamily);
    const ink = hex(rgba(s.color));
    const style = weightOf(s) + ' ' + s.fontSize + '/' + s.lineHeight + ' ' + family + (s.fontStyle === 'italic' ? ' italic' : '') + (s.textTransform !== 'none' ? ' ' + s.textTransform : '') + (s.letterSpacing !== 'normal' ? ' spacing ' + s.letterSpacing : '') + ' ' + ink;
    const kind = kindOf(el);
    const styles = kinds[kind] || (kinds[kind] = new Map());
    const entry = styles.get(style) || { style, count: 0, example: clean(el.innerText, 50), ref: refOf(el) };
    entry.count++;
    styles.set(style, entry);
    const f = families.get(family) || { family, count: 0, stack: clean(s.fontFamily, 120), renders: fontRenders(family) };
    f.count++;
    families.set(family, f);
    colors.set(ink, (colors.get(ink) || 0) + 1);
  }
  for (const el of [...document.body.querySelectorAll('*')].slice(0, 6000)) {
    const c = rgba(getComputedStyle(el).backgroundColor);
    if (c[3] < 0.05) continue;
    const r = el.getBoundingClientRect();
    if (r.width * r.height < 400) continue;
    const key = hex(c);
    backgrounds.set(key, (backgrounds.get(key) || 0) + 1);
  }
  const ORDER = ['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'Button', 'Link', 'Menu', 'Body text', 'Form', 'Footer text'];
  const top = (map) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([value, count]) => ({ value, count }));
  return {
    kinds: ORDER.filter((kind) => kinds[kind]).map((kind) => ({ kind, styles: [...kinds[kind].values()].sort((a, b) => b.count - a.count) })),
    families: [...families.values()].sort((a, b) => b.count - a.count),
    textColors: top(colors), backgroundColors: top(backgrounds),
  };
}`

/** The page's visible copy, one entry per block of text (paragraph, heading, list item, button, link). */
export const TEXT_SCRIPT = `(limit) => {${PAGE_HELPERS}
  const BLOCK = 'p, li, h1, h2, h3, h4, h5, h6, td, th, dt, dd, figcaption, blockquote, summary, caption, legend';
  const blocks = [], used = new Set();
  const captured = (el) => { for (let node = el; node; node = node.parentElement) if (used.has(node)) return true; return false; };
  const add = (el, text) => { used.add(el); blocks.push({ ref: refOf(el), tag: el.tagName.toLowerCase(), text }); };
  // Innermost blocks first: a paragraph, with its links, is one entry; a list item holding a sub-list is not.
  for (const el of document.body.querySelectorAll(BLOCK)) {
    if (blocks.length >= limit) break;
    if (!shown(el) || [...el.querySelectorAll(BLOCK)].some((inner) => clean(inner.innerText))) continue;
    const text = clean(el.innerText, 800);
    if (text) add(el, text);
  }
  // Links, buttons and labels outside those blocks: menus, calls to action, form labels.
  for (const el of document.body.querySelectorAll('a, button, label')) {
    if (blocks.length >= limit) break;
    if (!shown(el) || captured(el)) continue;
    const text = clean(el.innerText, 300);
    if (text) add(el, text);
  }
  // Text that sits straight in a div or span.
  for (const el of textElements(3000)) {
    if (blocks.length >= limit) break;
    if (captured(el)) continue;
    const text = clean([...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.nodeValue).join(' '), 800);
    if (text) add(el, text);
  }
  return { lang: document.documentElement.lang || '', title: document.title, host: location.hostname, blocks };
}`

/** SEO data beyond the basics: structured data, social cards, hreflang, links and headings. */
export const SEO_SCRIPT = `() => {${PAGE_HELPERS}
  const meta = (selector) => document.querySelector(selector)?.getAttribute('content') || '';
  const types = [], errors = [];
  const collect = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(collect);
    if (node['@type']) types.push(...[].concat(node['@type']).map(String));
    if (node['@graph']) collect(node['@graph']);
  };
  const scripts = document.querySelectorAll('script[type="application/ld+json"]');
  scripts.forEach((script) => { try { collect(JSON.parse(script.textContent)); } catch (error) { errors.push(clean(error.message, 100)); } });
  let internal = 0, external = 0, nofollow = 0;
  for (const a of document.querySelectorAll('a[href]')) {
    try {
      const url = new URL(a.href);
      if (!/^https?:$/.test(url.protocol)) continue;
      if (url.hostname === location.hostname) internal++; else external++;
      if (/nofollow/i.test(a.rel)) nofollow++;
    } catch {}
  }
  return {
    url: location.href, title: document.title, description: meta('meta[name="description"]'), robots: meta('meta[name="robots"]'),
    canonical: document.querySelector('link[rel="canonical"]')?.href || '',
    hreflang: [...document.querySelectorAll('link[rel="alternate"][hreflang]')].slice(0, 20).map((link) => link.hreflang + ' ' + link.href),
    og: { title: meta('meta[property="og:title"]'), description: meta('meta[property="og:description"]'), image: meta('meta[property="og:image"]'), url: meta('meta[property="og:url"]'), type: meta('meta[property="og:type"]') },
    twitter: { card: meta('meta[name="twitter:card"]'), image: meta('meta[name="twitter:image"]') },
    jsonLd: { blocks: scripts.length, types: [...new Set(types)].slice(0, 20), errors: errors.slice(0, 5) },
    microdata: document.querySelectorAll('[itemtype]').length,
    words: (document.body.innerText.match(/[\\p{L}\\p{N}][\\p{L}\\p{N}'’-]*/gu) || []).length,
    links: { internal, external, nofollow },
    headings: [1, 2, 3, 4, 5, 6].map((level) => document.querySelectorAll('h' + level).length),
    generator: meta('meta[name="generator"]'),
    images: document.images.length,
  };
}`
