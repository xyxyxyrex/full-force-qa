# CLAUDE.md — QA Snapshot Editor

## What This App Does

An Electron desktop app that captures live WordPress/Elementor staging pages into frozen, editable snapshots for visual QA. The user can resize elements, change fonts, tweak spacing/colors — like Figma — without ever writing back to the real site. Built for a QA analyst at an SEO company who compares staging sites against design specs.

## Tech Stack

- **Electron** (v35) — app shell, hidden-window capture, IPC
- **React 18** + **Vite** — renderer UI
- **TypeScript** — strict mode everywhere
- **GrapesJS v0.23.3** — visual HTML editor (canvas iframe)
- **electron-vite v5** — build tooling
- No database — projects stored as JSON in `userData`

## Project Structure

```
src/
├── main/                    # Electron main process (Node.js)
│   ├── index.ts             # App lifecycle, IPC handlers, window creation
│   ├── capture.ts           # Hidden-window page capture (~614 lines)
│   ├── snapshot.ts          # HTML freezing (URL rewrite, script strip)
│   └── store.ts             # Project persistence (JSON file)
├── preload/
│   └── index.ts             # contextBridge API (typed IPC)
├── renderer/
│   └── src/
│       ├── main.tsx          # React mount
│       ├── App.tsx           # View router (dashboard → capture → editor)
│       ├── components/
│       │   ├── Dashboard.tsx     # Project list/grid
│       │   ├── CaptureScreen.tsx # WP login + URL input + capture trigger
│       │   └── EditorWorkspace.tsx # GrapesJS canvas + all inspector tools (~1772 lines)
│       └── grapesjs/
│           ├── init.ts       # GrapesJS config, style syncing, font loading (~1015 lines)
│           └── theme.css     # Dark theme overrides for GrapesJS UI
└── shared/
    └── types.ts              # CaptureResult, Project, ElectronAPI interfaces
```

## Build & Run

```bash
npm run dev          # Electron + Vite dev server
npm run build        # Compile TypeScript (output → out/)
npm run preview      # Run built app
npm run build:dist   # Package with electron-builder
```

**Important:** Main process changes require app restart. Renderer changes hot-reload.

## Data Flow: Capture → Freeze → Edit

```
1. User enters staging URL in CaptureScreen
2. Main process: captureUrl() opens hidden BrowserWindow (1920×1080)
   - Loads page, waits 3s for dynamic rendering
   - Scrolls through page (triggers lazy-load + animations)
   - Reveals hidden animated elements (removes elementor-invisible, etc.)
   - Removes cookie/consent overlays
   - Captures ALL CSS rules (CSSOM) into inline <style> block
   - Bakes non-responsive computed styles as inline styles
   - Extracts functional script URLs → stores in <meta> tag
   - Collapses empty containers
   - Returns document.documentElement.outerHTML
3. Main process: freezeSnapshot() post-processes HTML
   - Resolves lazy-loaded images (data-src → src)
   - Rewrites relative URLs to absolute
   - Strips ALL <script> tags and event handlers
   - Injects <base> tag
4. Frozen HTML sent to renderer via IPC
5. Renderer: initEditor() in grapesjs/init.ts
   - Parses HTML: extracts body, CSS links, inline styles, body/html attrs, preserved scripts
   - Strips responsive inline styles (display, font-size, padding, etc.)
   - Strips iframes and noscripts
   - Initializes GrapesJS with the processed body HTML
   - Load handler: injects CSSOM, CSS vars, body classes, media-constrained links
   - Collapses empty containers (bottom-up recursive)
   - Re-injects preserved scripts sequentially (jQuery first, then plugins)
   - Scans fonts, loads from Google Fonts + CDN
```

## IPC Channels

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `auth:login` | renderer → main | Opens modal BrowserWindow for WP-admin login |
| `capture:start` | renderer → main | Triggers captureUrl() + freezeSnapshot() |
| `projects:list` | renderer → main | Returns Project[] from projects.json |
| `projects:save` | renderer → main | Upserts project by ID |
| `projects:delete` | renderer → main | Removes project by ID |

## Critical Architecture Decisions

### Why Scripts Are Stripped (and then selectively re-injected)

Scripts are stripped in `snapshot.ts` for safety (prevents analytics, tracking, side effects). But functional scripts (jQuery, Elementor frontend.js, chat widgets) are preserved:

1. **capture.ts** extracts all `<script src="...">` URLs, filtering out analytics/tracking via a blacklist regex
2. URLs stored in `<meta name="snapshot-preserved-scripts">` tag (survives script stripping)
3. **init.ts** reads the meta tag, injects scripts sequentially into the GrapesJS canvas iframe via `createElement('script')` + `appendChild()`
4. Sequential loading ensures dependency order (jQuery before plugins)

### Why CSSOM Is Captured as Inline `<style>`

External CSS `<link>` tags can't reliably load in the GrapesJS iframe (CORS, relative paths, cascade order issues). Solution: extract all CSS rules via `document.styleSheets[].cssRules` at capture time, including recursive `@import` resolution, and inject as a single `<style data-snapshot-cssom>` block at the **beginning** of `<head>` so GrapesJS-generated rules (user edits) naturally win via CSS cascade order.

### Why Responsive Inline Styles Are Stripped

capture.ts bakes computed styles at 1920px desktop viewport. If font-size, padding, display, etc. are baked as inline styles, they override CSS `@media` queries at ALL viewport sizes. Solution: the `RESPONSIVE_PROPS` set lists ~20 properties that must NOT be inline. These are stripped from the HTML string before GrapesJS parses it AND from the live DOM in the load handler.

**RESPONSIVE_PROPS:** display, flex-direction, justify-content, align-items, flex-wrap, order, grid-template-columns, grid-template-rows, font-family, font-size, line-height, letter-spacing, font-weight, padding (all sides), margin (all sides), gap, max-width, text-align

**NOT stripped (would break layout):** width, min-width — Elementor columns depend on these.

### Style Override Strategy

```
Priority (highest → lowest):
1. Inline !important (user edits from style panel)
2. GrapesJS CssComposer rules (class-based)
3. Captured CSSOM <style> block (original page CSS)
4. Browser defaults
```

- `component:selected` syncs computed styles into GrapesJS model (so the style panel shows current values)
- Synced values tracked in `_syncedDefaults` WeakMap — these do NOT get `!important`
- Only user-changed values (different from synced default) get inline `!important`
- On device change: all `!important` overrides cleared, re-synced for new viewport

### GrapesJS Device Configuration

```typescript
devices: [
  { name: 'Desktop', width: '1900px', widthMedia: '' },      // no @media wrapper
  { name: 'Tablet',  width: '1199px', widthMedia: '1199px' }, // @media (max-width: 1199px)
  { name: 'Mobile',  width: '767px',  widthMedia: '767px' },  // @media (max-width: 767px)
  { name: 'Custom',  width: '1900px', widthMedia: '' },       // no @media wrapper
]
```

**Critical:** `widthMedia: ''` on Desktop/Custom prevents GrapesJS from wrapping ALL user edits in `@media (max-width: 1900px)`, which would make `_applyInline` skip them.

### Widget/Interactive Element Handling

Chat widgets (Tidio, Intercom, etc.) and other interactive elements are handled via script preservation:

1. During capture, ALL external script URLs are extracted (except blacklisted analytics)
2. Stored as `<meta name="snapshot-preserved-scripts" content="url1|||url2|||...">`
3. After GrapesJS loads, scripts are injected sequentially into the canvas iframe
4. Widgets initialize fresh — fully functional (clickable, interactive)

Elements marked with `data-widget-frozen` attribute have their inline styles protected from responsive stripping.

### Empty Container Collapse

After stripping iframes/scripts, many containers become empty but retain dimensions (min-height, padding from CSS). Two-stage collapse:

1. **capture.ts**: Collapse empty leaf containers (no children, no text, no background)
2. **init.ts**: Bottom-up recursive collapse — process deepest containers first, then parents whose children are all hidden

SVGs ≤24px are treated as decorative and don't prevent collapsing.

## Editor Features (EditorWorkspace.tsx)

| Feature | Description |
|---------|-------------|
| **Top Tabs** | Switch between `Layout` mode and `Audit` SEO mode while keeping central canvas and left layers tree active |
| **SEO Audit Inspector** | GrapesJS CAD-style right panel inspector: `META TAGS`, `HEADER TAGS`, `IMAGES & ALT`, `LINKS & ANCHORS`, `DUPLICATE CONTENT`, and `ASSETS & LIBRARIES` (Internal/External JS & CSS) |
| **Duplicate Detection Overlay** | Automatic canvas duplicate detection when switching to `Audit` tab: highlights duplicate headings & text blocks in red with `[Duplicate]` overlay badges; switching back to `Layout` restores clean canvas |
| **Device Presets** | Desktop/Tablet/Mobile with responsive CSS |
| **Free Transform** | Custom dimensions, drag-to-resize edges |
| **Zoom** | 25–200%, Ctrl+scroll, fit-to-screen |
| **Rulers & Guides** | Photoshop-style, drag from ruler to create guide, double-click to remove |
| **Font Inspector** | Badge overlay on text elements showing font name, hover tooltip with details |
| **Boundaries Inspector** | Visual margin (orange), padding (green), dimensions, gap measurement |
| **Color Palette** | Extract all page colors, grayscale + highlight selected |
| **Style Panel** | Typography, Spacing, Size, Appearance sectors |
| **Selector Panel** | GrapesJS class-based CSS editing |
| **Layer Panel** | Component tree |
| **Hard Refresh** | F5 / Ctrl+R / button — re-captures from staging URL |

## Font System

1. **Discovery**: After GrapesJS loads, scan all elements' computed `font-family`
2. **Classification**: Separate system fonts, web fonts, icon fonts
3. **Loading**: Google Fonts API for text fonts, CDN for icon fonts (Font Awesome, Material Icons)
4. **Verification**: Canvas-based rendering test + FontFaceSet status check
5. **UI**: Font dropdown populated with discovered fonts; missing fonts reported to user

## Known Bugs Fixed (Session History)

These were debugged and fixed during development. Context preserved for future sessions:

1. **Responsive CSS not working**: Baked inline styles (font-size, padding, display) overrode @media queries. Fixed by creating RESPONSIVE_PROPS set and stripping those from inline styles before GrapesJS parses them.

2. **Font-family not changing**: Multiple compounding causes:
   - Captured CSSOM `<style>` was appended at END of head (overrode GrapesJS rules) → moved to BEGINNING
   - External CSS links via `canvas.styles` loaded AFTER GrapesJS styles → set `canvas.styles` to `[]`
   - Desktop `widthMedia` was `'1900px'`, wrapping all edits in `@media` that `_applyInline` skipped → set to `''`
   - `_applyInline` ignored all rules with `mediaText` → now includes current device's media rules
   - `component.getStyle()` had stale font-family overwriting CssComposer user edits → component styles only merge for properties CssComposer hasn't set

3. **Whitespace at top**: Empty iframes (chat widgets, analytics) taking space after content removed. Fixed by stripping all iframes in `stripNonContentElements()`.

4. **Whitespace at bottom**: Empty parent containers left after iframe/widget removal. Fixed by bottom-up recursive collapse in init.ts load handler.

5. **Left whitespace**: Stripping `width`/`min-width` from inline styles broke Elementor column layout. Fixed by removing those from RESPONSIVE_PROPS.

6. **Small decorative SVGs preventing collapse**: Blanket `querySelector('svg')` check treated any SVG as meaningful content. Fixed by only counting SVGs >24px as meaningful.

7. **Whitespace at bottom from SVG sprite sheets & stripped display:none**: Stripping `display` from inline styles removed `display: none` from hidden SVG icon sprite sheets (`<svg style="display:none">`) and hidden helper tags sitting at the bottom of `<body>`. Browsers rendered unhidden SVGs as 300×150 layout blocks below `<footer>`. Fixed by:
   - Preserving `display: none` when stripping responsive inline properties in `stripBakedResponsiveStyles()` and live DOM cleanup in `init.ts`
   - Explicitly applying `display: none` to SVG sprite sheets (`<svg>` containing `<symbol>` or `<defs>`) and post-footer non-content elements
   - Stripping `<link>` tags from `bodyHtml` in `stripNonContentElements()` to prevent unwanted `Link` components at the root of `Body`

## Analytics/Tracking Script Blacklist

These scripts are filtered OUT during capture (not re-injected):

```
google-analytics.com, googletagmanager.com, gtag/js, connect.facebook.net,
fbevents, hotjar.com, static.hotjar, mixpanel.com, cdn.segment.(com|io),
doubleclick.net, googlesyndication.com, adsbygoogle, pagead2,
google.com/recaptcha, gstatic.com/recaptcha, nr-data.net, newrelic,
sentry-cdn, sentry.io/sdk, bugsnag, datadoghq.com, clarity.ms,
optimizely.com, crazyegg.com, mouseflow.com, smartlook, fullstory.com,
heap-analytics, cdn.amplitude, plausible.io, matomo, piwik, clicky.com,
statcounter.com, chartbeat.com, pardot.com, marketo.(net|com), mc.yandex
```

## File-by-File Quick Reference

| File | Lines | Key Function/Export |
|------|-------|-------------------|
| `main/index.ts` | 89 | `createWindow()`, IPC handler registration |
| `main/capture.ts` | 614 | `captureUrl(url): Promise<string>` |
| `main/snapshot.ts` | 130 | `freezeSnapshot(html, sourceUrl): string` |
| `main/store.ts` | 39 | `getProjects()`, `saveProject()`, `deleteProject()` |
| `preload/index.ts` | 20 | `contextBridge.exposeInMainWorld('electronAPI', ...)` |
| `renderer/App.tsx` | 110 | View router, state management |
| `renderer/Dashboard.tsx` | 121 | Project list grid |
| `renderer/CaptureScreen.tsx` | 200 | WP login flow + capture trigger |
| `renderer/EditorWorkspace.tsx` | 1772 | GrapesJS canvas + all inspector tools |
| `renderer/grapesjs/init.ts` | 1015 | `initEditor()`, `loadMissingFonts()` |
| `renderer/grapesjs/theme.css` | 431 | Dark theme CSS for GrapesJS |
| `shared/types.ts` | 22 | `CaptureResult`, `Project`, `ElectronAPI` |

## User Context

The user is a QA analyst at an SEO company. They compare WordPress staging sites against Figma designs. They need pixel-perfect visual accuracy at all breakpoints. Their primary concern is 1:1 parity between the snapshot editor and the live staging site. They care deeply about:
- Correct fonts, sizes, spacing, colors
- Responsive behavior matching the staging site
- Interactive widgets (Tidio chat, etc.) being functional
- No unexplained whitespace or layout shifts
