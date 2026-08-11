# Parity

Parity is an Electron desktop application for quality assurance engineers, web developers, and designers reviewing website implementations. It pulls tickets from Monday.com, compares staging pages with live Figma frames, runs OpenCV visual diffs, supports visual inline editing in Chromium webviews, performs SEO and grammar checks, and tracks QA progress in an embedded spreadsheet.

---

## Core Workspaces and Features

The application interface is structured into four project workspaces (`Live`, `Edit`, `Audit`, and `Automate`) plus Dashboard and private Notes views. A VS Code-style activity bar provides auto-hiding navigation and can be pinned open.

### Private Notes and account sync
- **Monday-backed identity**: Monday OAuth identifies the current Parity user. A server-side Supabase Edge Function verifies Monday identity and keeps each user's settings, folders, projects, and notes isolated.
- **Notes workspace**: Provides folders, tags, pins, archive, search, filtering, sorting, and a rich-text editor with headings, lists, quotes, code blocks, links, compressed images, paste-to-attach, and local files.
- **Local attachment storage**: Note attachment bytes and project capture thumbnails remain in Electron's local application-data directory. Supabase stores only the private rich-text documents, account state, project metadata, and attachment metadata.

### 1. Live Workspace (`live`)
- **Monday.com Ticket Integration**: Uses OAuth 2.1 with PKCE, encrypted desktop credential storage, automatic refresh, and an editable board/assignee picker. Personal API tokens remain an advanced fallback and are encrypted by the operating system rather than stored in renderer storage.
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
  - **CSS Inspector & Editor**: Live CSS editor interface (`CssInspectorEditor.tsx`) for reading, writing, and overriding computed styles on selected DOM elements.
  - **History Stack**: Tracks DOM state mutations with step-by-step undo (`Ctrl+Z`) and redo (`Ctrl+Y`) capability.
- **Right Panel (`NativeStylePanel.tsx`)**:
  - **Typography Controls**: Font family selection, numeric font weights (100–900), font size, line height, letter spacing, text color hex picker, text alignment, text decoration, and text transform.
  - **Spacing & Box Model**: Numeric input controls and drag-scrubbers for top, right, bottom, and left margins and paddings, flexbox gap, display types (`block`, `flex`, `inline-block`, `grid`, `none`), flex direction, and alignment properties.
  - **Dimensions & Position**: Width, height, min/max bounds, positioning (`static`, `relative`, `absolute`, `fixed`, `sticky`), offsets (top, right, bottom, left), z-index, and overflow flags.
  - **Appearance & Background**: Background color picker, border width, border style (`solid`, `dashed`, `dotted`, etc.), border color, four-corner border radius, box shadow, opacity, and backdrop filters.
  - **Color & Font Inspector**: Scans page computed styles to detect used color palettes and loaded font families, rendering selectable buttons for style application.
- **Canvas & Inline Editing**:
  - **Interactive Selection**: Direct click-to-select element selection inside Chromium `<webview>` frames via `liveEditorBridge.ts`.
  - **Free-Transform & Resize Handles**: Eight-point resize handles for dynamic element resizing.
  - **Drag-to-Move**: Direct mouse dragging to update element CSS positioning.

### 3. Audit Workspace (`audit`)
- **Automated On-Page SEO Checks (`seoAudit.ts`)**:
  - **Meta Tags**: Validates presence and character length of `<title>` (optimal: 50–60 chars) and `<meta name="description">` (optimal: 120–155 chars). Checks canonical link tags, Open Graph tags (`og:title`, `og:description`, `og:image`), and Twitter Card meta tags.
  - **Heading Hierarchy**: Enforces single `<h1>` tag usage per page and indexes all `<h1>` through `<h6>` headings for structural validation.
  - **Image ALT Text**: Scans all `<img>` elements to identify missing `alt` attributes, non-empty alt text, and decorative `alt=""` declarations.
  - **Link & Anchor Analysis**: Audits all `<a>` tags for anchor text, `rel="nofollow"` flags, and internal versus external URL destination classification.
  - **Asset Network Traffic Audit**: Extracts internal and external JavaScript (`.js`) and CSS (`.css`) network dependencies captured during page load.
  - **Duplicate Content Detection**: Identifies repeated text blocks across DOM elements.
- **Grammar & Spell Checking (`grammarSpellAudit.ts`)**:
  - Integrates `harper.js` and `nspell` (Hunspell English dictionary) to parse text nodes (`<p>`, `<h1>`–`<h6>`, `<span>`, `<a>`, `<li>`, `<td>`, etc.) and flag spelling and grammatical errors with suggested corrections.
- **Visual Canvas Overlays**: Allows toggling canvas highlights directly on the staging frame for broken links, missing ALT text, missing href attributes, heading hierarchy, and grammar/spelling errors.

### 4. Automate Workspace (`automate`)
- **Figma vs. Staging Page Comparison (`AutomateWorkspace.tsx`)**:
  - Executes full-page scrolling screen capture of staging webviews to generate high-resolution comparison images.
  - Interacts with the Figma REST API (`https://api.figma.com/v1/files/...`) to download design frame images and extract design tokens (colors, font families, font sizes, line heights, letter spacing).
- **OpenCV Python Visual Worker (`python/visual_compare.py`)**:
  - Runs a standalone Python executable (`visual-compare`) compiled via PyInstaller.
  - Computes section-aware edge correlation (`cv2.Canny`, `cv2.matchTemplate`), structural similarity index (`skimage.metrics.structural_similarity`), and anchor-based vertical alignment to align scrolling web content against static design frames.
  - **Known Status**: Work-in-progress. The OpenCV visual diff detection algorithm exhibits known alignment inconsistencies when handling complex sticky headers, multi-axis responsive layouts, or long dynamic web pages.

### 5. Utilities, Overlays, and System Features
- **Viewport Simulator**: DevTools-style resolution presets (Desktop 1920x1200, Laptop, Tablet 1180x820 landscape, Mobile 430x932) with dynamic zoom controls (25% to 200%).
- **Ruler System**:
  - Top and left canvas ruler bars.
  - Downward-pointing (`▼`) and rightward-pointing (`▶`) triangle position markers on the rulers corresponding to active guide lines.
  - Drag-from-ruler guide creation, existing guide dragging, and drag-outside guide deletion.
  - Hover tooltips displaying exact pixel coordinates (`X: 420px`, `Y: 340px`).
  - **New Guide Layout Modal**: Grid guide generator supporting column count, row count, column gutter (px), row gutter (px), uniform margin (px), and individual top, right, bottom, and left margins.
- **Box-Model & Boundary Overlays**: Visual outline highlights for element padding and margin boundaries (`Ctrl+B`).
- **Theme System**: 36 built-in themes (including Dark Sleek, Light Clean, Catppuccin Mocha, Nord, Cyberpunk Gold, Tokyo Night, Dracula Pro, GitHub Dark, OLED Pitch Black) configured via `SettingsModal.tsx` with circular 4-quadrant preview buttons.

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
│   └── electron-dev.js         # Cross-platform environment launcher script
├── src/
│   ├── main/                   # Electron main process (IPC handlers, windows, native capture)
│   │   ├── index.ts
│   │   └── preload.ts
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
| **sharp (`^0.35.3`)** | Server-side/main process image processing for snapshot cropping and scaling. |
| **harper.js (`^2.7.0`)** | In-browser grammar checking engine used in `grammarSpellAudit.ts`. |
| **nspell (`^2.1.5`) & dictionary-en** | Hunspell-compatible spell checking engine for text content auditing. |
| **opencv-python-headless (`>=4.11`)** | Image processing, Canny edge detection, and template matching in Python visual worker. |
| **scikit-image (`>=0.25`)** | Structural Similarity Index (SSIM) calculation in `python/visual_compare.py`. |
| **PyInstaller (`>=6.11`)** | Compiles `python/visual_compare.py` into a standalone binary (`visual-compare.exe` / `visual-compare`). |

---

## Installation and Setup

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
VITE_EPHEMERAL_VIEWER_URL=https://parity-rz8.pages.dev
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

---

## Known Limitations

1. **Automate OpenCV Visual Comparison**:
   The automated section-aware comparison engine (`python/visual_compare.py`) is work-in-progress. Edge-matching and SSIM algorithms may produce false positives or misaligned regions on pages containing fixed/sticky headers, CSS animations, or dynamic JavaScript layout changes.
2. **Chromium Webview Security Constraints**:
   Target website staging servers with strict Content Security Policies (CSP) or X-Frame-Options headers may require disabling web security flags in Electron main process settings (`webPreferences.webSecurity: false`).
