// Scripts the agent's browser runs inside the page. Each is a function source string, called with
// JSON arguments. They only read the page, mark interactive elements with data-parity-ref, and do
// what a person would (focus, choose an option); clicks and typing are real input events.

const HELPERS = `
  const clean = (text, max = 80) => String(text || '').replace(/\\s+/g, ' ').trim().slice(0, max);
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
  };
  const byRef = (ref) => document.querySelector('[data-parity-ref="' + ref + '"]');
`

export const SNAPSHOT_SCRIPT = `(limit) => {${HELPERS}
  window.__parityRefCounter = window.__parityRefCounter || 0;
  const vw = innerWidth, vh = innerHeight;
  const labelFor = (el) => {
    const aria = el.getAttribute('aria-label'); if (aria && clean(aria)) return clean(aria);
    const by = el.getAttribute('aria-labelledby');
    if (by) { const t = by.split(/\\s+/).map((id) => document.getElementById(id)?.innerText || '').join(' '); if (clean(t)) return clean(t); }
    if (el.id) { const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l && clean(l.innerText)) return clean(l.innerText); }
    const wrap = el.closest('label'); if (wrap && el.tagName !== 'A' && clean(wrap.innerText)) return clean(wrap.innerText);
    if (el.placeholder) return clean(el.placeholder);
    const text = clean(el.innerText || el.textContent); if (text) return text;
    const img = el.querySelector && el.querySelector('img[alt]'); if (img && clean(img.alt)) return clean(img.alt);
    if (el.title) return clean(el.title);
    if (el.value && (el.type === 'submit' || el.type === 'button')) return clean(el.value);
    return clean(el.getAttribute('name') || '');
  };
  const selector = 'a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=menuitem], [role=tab], [role=checkbox], [role=radio], [role=switch], [role=combobox], [onclick], [contenteditable=true]';
  const forms = [...document.forms];
  const rows = [...document.querySelectorAll(selector)].filter(visible).map((el, order) => {
    if (!el.dataset.parityRef) el.dataset.parityRef = 'e' + (++window.__parityRefCounter);
    const r = el.getBoundingClientRect();
    const tag = el.tagName.toLowerCase();
    const type = tag === 'input' ? (el.type || 'text') : undefined;
    const role = el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'button' || type === 'submit' || type === 'button' ? 'button' : tag === 'select' ? 'select' : tag === 'textarea' ? 'textbox' : type === 'checkbox' || type === 'radio' ? type : tag === 'input' ? 'textbox' : tag);
    const row = { ref: el.dataset.parityRef, tag, role, name: labelFor(el), inViewport: r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw, order };
    if (type) row.type = type;
    if (tag === 'a') row.href = el.getAttribute('href');
    if ((tag === 'textarea' || tag === 'select' || tag === 'input') && !['submit', 'button', 'checkbox', 'radio', 'reset', 'image'].includes(type || '')) row.value = type === 'password' ? (el.value ? '••••' : '') : clean(tag === 'select' ? el.options[el.selectedIndex]?.text : el.value, 60);
    if (type === 'checkbox' || type === 'radio') row.checked = !!el.checked;
    if (el.required) row.required = true;
    if (el.disabled) row.disabled = true;
    if (el.willValidate && !el.validity.valid && (el.value || el.dataset.parityTouched)) row.invalid = clean(el.validationMessage, 120);
    if (tag === 'select') row.options = [...el.options].slice(0, 12).map((o) => clean(o.text, 40));
    const form = el.form || el.closest('form'); if (form && forms.includes(form)) row.form = 'F' + (forms.indexOf(form) + 1);
    return row;
  });
  const ranked = [...rows].sort((a, b) => (Number(b.inViewport) - Number(a.inViewport)) || (Number(!!b.form) - Number(!!a.form)) || a.order - b.order);
  const elements = ranked.slice(0, limit).sort((a, b) => a.order - b.order).map(({ order, ...rest }) => rest);
  const formRows = forms.map((form, i) => {
    const id = 'F' + (i + 1);
    const mine = rows.filter((row) => row.form === id);
    return { id, action: form.getAttribute('action') || location.pathname, method: (form.getAttribute('method') || 'get').toUpperCase(), fields: mine.filter((row) => row.role !== 'button').map((row) => row.ref), submits: mine.filter((row) => row.role === 'button').map((row) => row.ref) };
  }).filter((form) => form.fields.length || form.submits.length);
  const headings = [...document.querySelectorAll('h1, h2, h3')].filter(visible).slice(0, 20).map((h) => ({ level: Number(h.tagName[1]), text: clean(h.innerText, 80) }));
  return { url: location.href, title: document.title, headings, elements, totalElements: rows.length, forms: formRows, scrollY: Math.round(scrollY), scrollHeight: document.documentElement.scrollHeight, viewport: { width: vw, height: vh } };
}`

/** Scrolls an element into view and says where to click it, and what (if anything) covers it. */
export const TARGET_SCRIPT = `(ref) => {${HELPERS}
  const el = byRef(ref);
  if (!el) return { error: 'missing' };
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const r = el.getBoundingClientRect();
  const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
  const top = document.elementFromPoint(x, y);
  let covered = null;
  if (top && top !== el && !el.contains(top) && !top.contains(el)) covered = top.tagName.toLowerCase() + (top.id ? '#' + top.id : '') + (typeof top.className === 'string' && top.className.trim() ? '.' + top.className.trim().split(/\\s+/).slice(0, 2).join('.') : '');
  return { x, y, covered, disabled: !!el.disabled, visible: visible(el) };
}`

export const FOCUS_SCRIPT = `(ref, clear) => {${HELPERS}
  const el = byRef(ref);
  if (!el) return { error: 'missing' };
  el.scrollIntoView({ block: 'center', behavior: 'instant' });
  el.dataset.parityTouched = '1';
  el.focus();
  if (clear && 'value' in el) {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
    if (setter) setter.call(el, ''); else el.value = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  return { focused: document.activeElement === el, editable: el.isContentEditable || ['input', 'textarea'].includes(el.tagName.toLowerCase()) };
}`

export const SELECT_SCRIPT = `(ref, wanted) => {${HELPERS}
  const el = byRef(ref);
  if (!el) return { error: 'missing' };
  if (el.tagName.toLowerCase() !== 'select') return { notSelect: true };
  const target = String(wanted).toLowerCase();
  const options = [...el.options];
  const option = options.find((o) => o.value.toLowerCase() === target) || options.find((o) => clean(o.text).toLowerCase() === target) || options.find((o) => clean(o.text).toLowerCase().includes(target));
  if (!option) return { error: 'no-option', options: options.map((o) => clean(o.text, 40)) };
  el.dataset.parityTouched = '1';
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
  setter.call(el, option.value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { chosen: clean(option.text, 60) };
}`

export const SCROLL_SCRIPT = `(to) => {
  const y = to === 'top' ? 0 : to === 'bottom' ? document.documentElement.scrollHeight : to === 'up' ? scrollY - innerHeight * 0.8 : to === 'down' ? scrollY + innerHeight * 0.8 : Number(to) || 0;
  window.scrollTo({ top: y, behavior: 'instant' });
  return Math.round(scrollY);
}`

export const LINKS_SCRIPT = `() => {${HELPERS}
  return [...document.querySelectorAll('a[href]')].map((a) => ({ href: a.getAttribute('href') || '', resolved: a.href, text: clean(a.innerText || a.getAttribute('aria-label') || a.querySelector('img')?.alt || a.title || '', 60) }));
}`

export const AUDIT_SCRIPT = `() => {${HELPERS}
  const meta = (name) => document.querySelector('meta[name="' + name + '"]')?.content || '';
  const prop = (name) => document.querySelector('meta[property="' + name + '"]')?.content || '';
  const images = [...document.images];
  const headings = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')].filter(visible).map((h) => ({ level: Number(h.tagName[1]), text: clean(h.innerText, 60) }));
  const jumps = headings.flatMap((h, i) => (i > 0 && h.level > headings[i - 1].level + 1 ? ['H' + headings[i - 1].level + ' → H' + h.level + ' "' + h.text + '"'] : [])).slice(0, 8);
  const named = (el) => clean(el.innerText) || el.getAttribute('aria-label') || el.getAttribute('title') || el.querySelector('img[alt]:not([alt=""])') || el.getAttribute('aria-labelledby');
  const fields = [...document.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]), select, textarea')].filter(visible);
  const unlabeled = fields.filter((el) => !(el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]')) && !el.closest('label') && !el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby') && !el.title).map((el) => el.tagName.toLowerCase() + (el.name ? '[name=' + el.name + ']' : '') + (el.placeholder ? ' (placeholder "' + clean(el.placeholder, 30) + '")' : ''));
  const ids = {}; document.querySelectorAll('[id]').forEach((el) => { ids[el.id] = (ids[el.id] || 0) + 1; });
  const mixed = location.protocol === 'https:' ? [...document.querySelectorAll('img[src^="http:"], script[src^="http:"], iframe[src^="http:"], link[rel="stylesheet"][href^="http:"]')].map((el) => el.src || el.href).slice(0, 10) : [];
  const resources = performance.getEntriesByType('resource');
  const nav = performance.getEntriesByType('navigation')[0];
  return {
    title: document.title, description: meta('description'), canonical: document.querySelector('link[rel="canonical"]')?.href || '', robots: meta('robots'), lang: document.documentElement.lang || '', viewport: meta('viewport'),
    h1: headings.filter((h) => h.level === 1).map((h) => h.text), headingJumps: jumps, ogTitle: prop('og:title'), ogImage: prop('og:image'), favicon: !!document.querySelector('link[rel~="icon"]'),
    imagesWithoutAlt: images.filter((img) => !img.hasAttribute('alt') && visible(img)).map((img) => img.currentSrc || img.src).slice(0, 10),
    brokenImages: images.filter((img) => img.complete && img.naturalWidth === 0 && (img.currentSrc || img.src)).map((img) => img.currentSrc || img.src).slice(0, 10),
    unnamedLinks: [...document.querySelectorAll('a[href]')].filter((a) => visible(a) && !named(a)).length,
    unnamedButtons: [...document.querySelectorAll('button, [role=button]')].filter((b) => visible(b) && !named(b)).length,
    unlabeledInputs: unlabeled.slice(0, 10), duplicateIds: Object.keys(ids).filter((id) => ids[id] > 1).slice(0, 10), mixedContent: mixed,
    loadMs: nav ? Math.round(nav.loadEventEnd || nav.duration) : null, requests: resources.length,
    transferKb: Math.round(resources.reduce((sum, r) => sum + (r.transferSize || 0), 0) / 1024),
    largeImages: resources.filter((r) => r.initiatorType === 'img' && (r.transferSize || r.encodedBodySize) > 300 * 1024).map((r) => ({ url: r.name, kb: Math.round((r.transferSize || r.encodedBodySize) / 1024) })).slice(0, 10),
  };
}`

export const call = (script: string, ...args: unknown[]) => `(${script})(${args.map((arg) => JSON.stringify(arg)).join(', ')})`

/** Runs before the site's own scripts when sending is off: a form that would POST is stopped inside the
 * page, so the page stays as it was (with the agent's typing) instead of turning into an error page.
 * Forms that send with fetch or XHR are stopped by the request rules instead. */
export const SEND_GUARD_SCRIPT = (binding: string): string => `(() => {
  const report = (url) => { try { window[${JSON.stringify(binding)}](String(url || location.href)); } catch {} };
  const posts = (form, submitter) => ((submitter && submitter.hasAttribute('formmethod') ? submitter.getAttribute('formmethod') : form.getAttribute('method')) || 'get').toLowerCase() === 'post';
  window.addEventListener('submit', (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || event.defaultPrevented || !posts(form, event.submitter)) return;
    event.preventDefault();
    report(event.submitter && event.submitter.hasAttribute('formaction') ? event.submitter.formAction : form.action);
  });
  const submit = HTMLFormElement.prototype.submit;
  HTMLFormElement.prototype.submit = function () { if (posts(this, null)) { report(this.action); return; } return submit.call(this); };
})()`
