# Parity

Parity is an Electron desktop application for quality assurance engineers, web developers, and designers reviewing website implementations. It combines authenticated Chromium previews, direct visual editing, Figma comparison, SEO and grammar audits, automated visual findings, annotations, and expiring browser-based review links in one QA workspace.

## Links

- **Parity landing page, installer, and ephemeral review host**: [https://parity-gfx.pages.dev](https://parity-gfx.pages.dev)
- **Latest Windows release**: [GitHub Releases](https://github.com/xyxyxyrex/full-force-qa/releases/latest)
- **PowerShell installer**: `irm https://parity-gfx.pages.dev/install.ps1 | iex`

---

## Core Workspaces and Features

Projects contain four primary workspaces (`Live`, `Edit`, `Audit`, and `Automate`). Annotate is a cross-workspace review layer that turns selected elements, manual drawings, and Automate findings into shareable QA items. Dashboard and private Notes are application-level views. A VS Code-style activity bar provides auto-hiding navigation and can be pinned open.

### Dashboard, projects, and account sync

- **Project management**: Create or edit projects with staging, admin, Figma, Google Sheets, and Monday ticket references. Browse nested folders as a familiar grid, drag projects or folders between locations, rubber-band multi-select items for bulk moves or guarded deletion, pin important work, search and sort, switch between card and list views, and move projects through a recoverable trash workflow. Folder hierarchy and placement are included in account sync.
- **Capture intake**: Add a project and all of its references immediately without waiting for Chromium capture, assign an optional display name, create it directly inside the current folder, or populate individual staging, Figma, and QA fields from Monday using compact inline pickers. Capture remains available when page content is needed.
- **Monday.com integration**: OAuth 2.1 with PKCE identifies the current user, stores desktop credentials with Electron `safeStorage`, refreshes credentials automatically, and supports editable board and assignee sources. An encrypted personal API token remains available as an advanced fallback.
- **Monday work queue**: Fetches and groups tickets, filters by board, status, or search text, detects attached staging/admin/Figma/Sheets resources, and can create or update a Parity project from a ticket.
- **Account state sync**: A Supabase Edge Function verifies Monday identity and isolates each user's settings, folders, pinned projects, project metadata, and notes.
- **Figma connection**: Maintains a reusable in-app browser session and an encrypted REST API token for Live and Automate workflows.

### Private Notes

- **Notes workspace**: Provides folders, tags, pins, archive, search, filtering, sorting, and a rich-text editor with headings, lists, quotes, code blocks, links, compressed images, paste-to-attach, and local files.
- **Local attachment storage**: Note attachment bytes and project capture thumbnails remain in Electron's local application-data directory. Supabase stores only the private rich-text documents, account state, project metadata, and attachment metadata.

### 1. Live Workspace (`live`)
- **Authenticated Chromium Preview**: Opens the target website in a native Electron webview and reuses the application's browser session, including cookies established through staging or WordPress authentication.
- **Figma Viewport Integration**: Renders Figma design frames inside an embedded `<webview>` using Figma embed URLs (`https://www.figma.com/embed?...`). Supports side-by-side positioning against the staging site frame or static PNG snapshot overlays.
- **Comparison Modes**: Provides four frame comparison modes:
  - `side-by-side`: Places the Figma frame adjacent to the staging website frame.
  - `overlay-opacity`: Layers the Figma image directly over the staging site with an adjustable opacity slider (0% to 100%).
  - `overlay-diff`: Calculates a visual pixel difference overlay between design and site snapshots.
  - `overlay-slider`: Provides an interactive horizontal split-curtain slider to compare design versus implementation.
- **Snapshot System**: Captures full-page HTML and CSS DOM snapshots of staging websites. Snapshots are stored in application storage and indexed by project ID to allow version comparison across development iterations.
- **Mastersheet / FortuneSheet Integration**: Embeds `@fortune-sheet/react` as an in-app QA tracking spreadsheet. Pre-populates a "QA Tracker" sheet with columns for Page Link, Section, Screenshot, Remarks, and Status. Supports linking external Google Sheets URLs via iframe embed.

### 2. Edit Workspace (`editBeta`)
- **Left Panel**:
  - **DOM Layer Tree**: Parses and renders the iframe DOM node hierarchy for layer selection, visibility toggling, and component isolation.
  - **CSS Inspector & Editor**: Reads and directly edits authored stylesheets with selector context, formatting, and live application to the page.
  - **History Stack**: Tracks local DOM and CSS patches with undo (`Ctrl+Z`), redo (`Ctrl+Y`), quick save, and revert-all controls.
- **Right Panel (`NativeStylePanel.tsx`)**:
  - **Typography Controls**: Font family selection, numeric font weights (100–900), font size, line height, letter spacing, text color hex picker, text alignment, text decoration, and text transform.
  - **Layout Controls**: Detects block, flexbox, and grid containers and edits direction, wrapping, distribution, alignment, row gap, and column gap. An optional flex/grid overlay visualizes the selected container on the active viewport.
  - **Spacing & Box Model**: Provides an editable visual box model plus numeric controls and drag-scrubbers for content size, margin, border, and padding.
  - **Dimensions & Position**: Width, height, min/max bounds, positioning (`static`, `relative`, `absolute`, `fixed`, `sticky`), offsets (top, right, bottom, left), z-index, and overflow flags.
  - **Appearance & Background**: Background color picker, border width, border style (`solid`, `dashed`, `dotted`, etc.), border color, four-corner border radius, box shadow, opacity, and backdrop filters.
  - **Color & Font Inspector**: Scans page computed styles to detect used color palettes and loaded font families, with collapsible inventories and usage highlighting.
- **Canvas & Inline Editing**:
  - **Interactive Selection**: Direct click-to-select element selection inside Chromium `<webview>` frames via `liveEditorBridge.ts`.
  - **Free-Transform & Resize Handles**: Eight-point resize handles for dynamic element resizing.
  - **Drag-to-Move**: Direct mouse dragging to update element CSS positioning.
  - **Computed and Authored Dimensions**: Displays rendered border-box geometry together with editable authored CSS width and height rules.
  - **Interaction and Eyedropper Modes**: Switches between element editing, native website interaction, and hovered-color inspection with HEX copying.
- **Responsive Editing**:
  - Single-device and multi-device canvas modes with desktop, tablet, mobile, and custom frames.
  - Layout changes are stored as local patches for the active viewport so breakpoint-specific edits remain isolated.

### 3. Audit Workspace (`audit`)
- **Automated On-Page SEO Checks (`seoAudit.ts`)**:
  - **Meta Tags**: Validates title and meta-description presence and advisory character ranges. Canonical, Open Graph, Twitter Card, and keyword metadata are inventoried for inspection.
  - **Headings**: Counts `<h1>` elements and lists all `<h1>` through `<h6>` headings.
  - **Image ALT Text**: Scans all `<img>` elements to identify missing `alt` attributes, non-empty alt text, and decorative `alt=""` declarations.
  - **Link & Anchor Inventory**: Lists all `<a>` tags with anchor text, `rel="nofollow"` flags, and internal versus external destination classification.
  - **Asset Network Traffic Audit**: Extracts internal and external JavaScript (`.js`) and CSS (`.css`) network dependencies captured during page load.
  - **Duplicate Content Detection**: Identifies repeated text blocks across DOM elements.
- **Grammar & Spell Checking (`grammarSpellAudit.ts`)**:
  - Integrates `harper.js` and `nspell` (Hunspell English dictionary) to parse rendered text nodes, locate spelling and grammar issues, show suggested corrections, and ignore individual findings.
- **Visual Canvas Overlays**: Shows links, image alt text, button targets, headings, grammar/spelling findings, and downloaded media file sizes directly on the audited page.
- **Overlay Display Modes**: Each overlay cycles independently through off, show on hover, show on click for multi-selection, and show all. Overlay labels scale responsively with canvas zoom.
- **Reporting**: Copies a Markdown audit summary or exports the structured report as JSON.

The current link audit inventories destinations but does not make HTTP requests to validate broken-link status. Canonical and social metadata are displayed rather than comprehensively validated, and heading analysis does not yet detect skipped heading levels.

### 4. Automate Workspace (`automate`)
- **Figma vs. Staging Page Comparison (`AutomateWorkspace.tsx`)**:
  - Executes full-page scrolling screen capture of staging webviews to generate high-resolution comparison images.
  - Interacts with the Figma REST API to load comparable frames, download design images, and extract colors, font families, font sizes, line heights, and letter spacing.
  - Produces Figma, live, and diff views with cropped evidence for layout, position, size, typography, design-token, missing-content, image-count, and page-height findings.
- **OpenCV Python Visual Worker (`python/visual_compare.py`)**:
  - Runs a standalone Python executable (`visual-compare`) compiled via PyInstaller.
  - Computes section-aware edge correlation (`cv2.Canny`, `cv2.matchTemplate`), structural similarity index (`skimage.metrics.structural_similarity`), and anchor-based vertical alignment to align scrolling web content against static design frames.
  - **Known Status**: Work-in-progress. The visual diff engine can exhibit alignment inconsistencies on complex sticky headers, animations, dynamic content, multi-axis responsive layouts, or long pages.
- **Finding Workflow**:
  - Filters findings by design token, layout, missing content, or verified results.
  - Accepts expected differences as baselines, marks false positives, and preserves triage per project.
  - Pins one or many findings into the annotation workflow.
  - Stores per-frame run history by desktop, tablet, and mobile breakpoint.

### Annotate and Ephemeral Review Sharing

Annotate is a cross-workspace action rather than a separate primary tab.

- **Annotation Tools**: Select an existing element or draw a selection box, arrow, rectangle, circle, freehand pen stroke, text note, or blur/redaction area. Annotations retain their page coordinates, viewport, device identity, color, title, notes, and badge number.
- **Finding-to-Annotation Workflow**: Selected page elements and pinned Automate findings can be converted directly into positioned annotations.
- **Before/After Recording**: Records the page before and after an editing session and opens a snipping studio for focused comparison evidence.
- **Full-Page Review Canvas**: Captures the active page, lets the author adjust annotation regions, and supports linking annotations into ordered review sequences.
- **Expiring Links**: `Generate Items` creates review links that expire after 3 days, 7 days, or 1 month.
- **Master and Item Links**:
  - A master link opens the complete page capture with every annotation and sequence.
  - Individual item links open a focused annotation crop while retaining the shared review context.
- **Cloudflare Pages Viewer**: Generated links open in a browser through [parity-gfx.pages.dev](https://parity-gfx.pages.dev) without requiring the Electron application.
- **Collaborative Review**: Reviewers can navigate annotations and sequences, change workflow statuses, post rich-text comments with images, open capture images in a lightbox, and receive status/comment changes through Supabase Realtime.
- **Expiring Storage**: Snapshot images, annotation metadata, comments, statuses, and rich-text assets are stored through Supabase and cleaned up after expiry.

Ephemeral review URLs are link-accessible while valid. Anyone who receives a generated URL can open its review until it expires, so links should be shared only with intended reviewers. `VITE_EPHEMERAL_VIEWER_URL` selects the browser viewer host used when generating links.

### 5. Utilities, Overlays, and System Features
- **Viewport Simulator**: DevTools-style resolution presets (Desktop 1920x1200, Laptop, Tablet 1180x820 landscape, Mobile 430x932) with dynamic zoom controls (25% to 200%). Edit-facing viewport controls live in a hover-revealed island below the URL bar; its caret can pin the controls open, while Live retains the compact inline toolbar.
- **Canvas Navigation**: Middle-mouse or Space-drag panning, zoom controls, canvas centering, and fit/reset behavior.
- **Ruler System**:
  - Top and left canvas ruler bars.
  - Downward-pointing (`▼`) and rightward-pointing (`▶`) triangle position markers on the rulers corresponding to active guide lines.
  - Drag-from-ruler guide creation, existing guide dragging, and drag-outside guide deletion.
  - Hover tooltips displaying exact pixel coordinates (`X: 420px`, `Y: 340px`).
  - **New Guide Layout Modal**: Grid guide generator supporting column count, row count, column gutter (px), row gutter (px), uniform margin (px), and individual top, right, bottom, and left margins.
- **Box-Model & Boundary Overlays**: Visual outline highlights for element padding and margin boundaries (`Ctrl+B`).
- **Custom Hotkeys**: Editable shortcuts grouped under General, Inspection, Panels, Viewports, Workspaces, and Annotate, with reserved-key and duplicate-conflict detection.
- **Theme System**: 37 built-in themes (including Parity, Dark Sleek, Light Clean, Catppuccin, Nord, Cyberpunk, Tokyo Night, Dracula, GitHub, and OLED variants).
- **Desktop Distribution**: Windows NSIS installer, GitHub Releases publishing, SHA-256-aware PowerShell bootstrapper, and `electron-updater` integration.

---

## Architecture and Technology Stack

```
full-force-seo/
├── python/                     # Python visual comparison worker
│   ├── requirements.txt        # Python dependency manifest
│   └── visual_compare.py       # OpenCV section-aware image alignment script
├── resources/                  # Extra resources bundled by electron-builder
│   └── visual_worker/          # Compiled PyInstaller executable output
├── scripts/                    # Development launchers and build helper scripts
│   ├── electron-dev.js         # Cross-platform environment launcher script
│   └── build-viewer.js         # Builds the Cloudflare Pages review viewer
├── supabase/                   # Sharing, identity, RLS, Realtime, and cleanup migrations/functions
├── viewer/                     # Cloudflare Pages landing page and ephemeral annotation reviewer
├── src/
│   ├── main/                   # Electron main process (IPC handlers, windows, native capture)
│   │   └── index.ts
│   ├── preload/                # Context bridge API bindings
│   │   └── index.ts
│   ├── renderer/               # React frontend application
│   │   └── src/
│   │     ├── components/       # Workspace components (Dashboard, EditorWorkspace, etc.)
│   │     ├── grapesjs/         # GrapesJS initialization and plugins
│   │     ├── theme/            # Theme tokens, styles, and settings persistence
│   │     ├── utils/            # Monday API, SEO audit, grammar audit utilities
│   │     └── App.tsx           # Main application shell and tab manager
│   └── shared/                 # Shared TypeScript interfaces and types
│       └── types.ts
├── electron.vite.config.ts     # Electron-Vite build configuration
├── package.json                # Node.js dependencies and lifecycle scripts
├── wrangler.jsonc              # Cloudflare Pages Direct Upload configuration
└── tsconfig.web.json           # Renderer TypeScript configuration
```

### Key Libraries and Tools

| Library / Tool | Role in Codebase |
| :--- | :--- |
| **Electron (`^43.2.0`)** | Desktop application shell providing main process IPC, system webviews, and native capture APIs. |
| **React (`^18.3.1`) & React DOM** | Frontend view framework for workspaces, inspector panels, toolbar controls, and modals. |
| **Vite (`^6.0.0`) & Electron-Vite** | Development server and bundle generator for main, preload, and renderer scripts. |
| **TypeScript (`^5.7.2`)** | Static type checking across main, renderer, and shared modules. |
| **GrapesJS (`^0.23.3`)** | Underlying visual DOM builder and asset management engine used in `EditorWorkspace.tsx`. |
| **@fortune-sheet/react (`^1.0.4`)** | In-app Excel-like spreadsheet component for the bottom QA tracker sheet. |
| **@supabase/supabase-js (`^2.112.2`)** | Account sync plus expiring capture, comment, status, rich-text asset, and Realtime review data. |
| **electron-updater (`^6.8.9`)** | Checks and installs published desktop updates from GitHub Releases. |
| **sharp (`^0.35.3`)** | Server-side/main process image processing for snapshot cropping and scaling. |
| **harper.js (`^2.7.0`)** | In-browser grammar checking engine used in `grammarSpellAudit.ts`. |
| **nspell (`^2.1.5`) & dictionary-en** | Hunspell-compatible spell checking engine for text content auditing. |
| **opencv-python-headless (`>=4.11`)** | Image processing, Canny edge detection, and template matching in Python visual worker. |
| **scikit-image (`>=0.25`)** | Structural Similarity Index (SSIM) calculation in `python/visual_compare.py`. |
| **PyInstaller (`>=6.11`)** | Compiles `python/visual_compare.py` into a standalone binary (`visual-compare.exe` / `visual-compare`). |

---

## Installation and Setup

### Install the latest Windows release

Run this command in PowerShell:

```powershell
irm https://parity-gfx.pages.dev/install.ps1 | iex
```

The bootstrapper resolves the latest published GitHub release, verifies its SHA-256 digest when GitHub provides one, and launches the Windows installer.

### Engine Requirements
- **Node.js**: Version 18.x or 20.x recommended
- **npm**: Package manager (uses `package-lock.json`)
- **Python**: Version 3.10+ (required for building the Python visual worker binary)

### 1. Clone Repository
```bash
git clone https://github.com/xyxyxyrex/full-force-qa.git
cd full-force-qa
```

### 2. Install Node Dependencies
```bash
npm install
```

### 3. Install Python Dependencies (Optional for Python worker development)
```bash
pip install -r python/requirements.txt
```

### 4. Environment Variables
Create a `.env` file in the project root using the public Supabase and viewer values from `.env.example`:
```env
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-publishable-or-legacy-anon-key
VITE_EPHEMERAL_VIEWER_URL=https://parity-gfx.pages.dev
```
Monday's client secret belongs only in Supabase Edge Function secrets. Figma personal access tokens are entered in the application and encrypted with Electron `safeStorage`; do not add either secret to `.env`.

---

## Development and Build Commands

Commands configured in `package.json`:

- **Run Application in Development Mode**:
  ```bash
  npm run dev
  ```
  Launches the Electron application with hot-module replacement (HMR) via `electron-vite`.

- **Compile Frontend & Main Process**:
  ```bash
  npm run build
  ```
  Compiles TypeScript sources and bundles application assets into the `out/` directory.

- **Build or Preview the Cloudflare Viewer**:
  ```bash
  npm run build:viewer
  npm run dev:viewer
  ```
  Builds `viewer/` into `dist-viewer/`; the development command serves that output through Wrangler Pages dev.

- **Deploy the Cloudflare Viewer**:
  ```bash
  npm run deploy:viewer
  ```
  Direct-uploads `dist-viewer/` to the `parity-gfx` Cloudflare Pages project. Production deployment is normally handled by GitHub Actions.

- **Compile Python Visual Worker Binary**:
  ```bash
  npm run build:visual-worker
  ```
  Runs PyInstaller to compile `python/visual_compare.py` into `resources/visual-worker/visual-compare.exe` (Windows) or `resources/visual-worker/visual-compare` (macOS/Linux).

- **Build Executable Desktop Installer**:
  ```bash
  npm run build:dist
  ```
  Compiles the Python visual worker binary, builds Electron TypeScript assets, and generates standalone installers via `electron-builder`.

- **Preview Built Application**:
  ```bash
  npm run preview
  ```

- **Publish the Windows Release**:
  ```bash
  npm run release:win
  ```
  Builds the visual worker and Electron application, then publishes the NSIS artifacts through the configured GitHub Releases provider.

---

## Known Limitations

1. **Automate OpenCV Visual Comparison**:
   The automated section-aware comparison engine (`python/visual_compare.py`) is work-in-progress. Edge-matching and SSIM algorithms may produce false positives or misaligned regions on pages containing fixed/sticky headers, CSS animations, or dynamic JavaScript layout changes.
2. **Chromium Webview Security Constraints**:
   Target website staging servers with strict Content Security Policies (CSP) or X-Frame-Options headers may require disabling web security flags in Electron main process settings (`webPreferences.webSecurity: false`).
3. **Audit Scope**:
   Link targets, canonical metadata, social metadata, and headings are currently inventoried from the captured document. Audit does not yet crawl link status codes, validate complete indexability, parse structured data, or enforce skipped heading levels.
4. **Ephemeral Review Access**:
   Generated review URLs act as bearer links and remain accessible to anyone who possesses the URL until expiry. They are intended for focused, temporary review rather than permanent or confidential archival.
