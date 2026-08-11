# PROJECT_SPEC.md — Parity (Phase 1)

## 1. Purpose

An internal Electron desktop application that lets a QA analyst freeze a live WordPress staging page into a disposable, editable snapshot, then visually adjust that snapshot (resize elements, change font sizes, tweak spacing/color) the way you would in Figma — without ever writing changes back to the real WordPress site.

This spec covers **Phase 1 only**: DOM capture + GrapesJS-based visual editing. Figma comparison, annotation/screenshotting, and sheet auto-fill are later phases and are explicitly out of scope here.

This document is written for an AI coding agent to implement against. Treat every section under "Requirements" as an acceptance criterion, not a suggestion.

---

## 2. Problem Context (for the agent's reference)

The user works in QA at an SEO company. Their job is comparing Figma designs against WordPress staging sites (fonts, sizing, responsiveness, layout) and logging issues manually via screenshots + a spreadsheet. This tool is the first piece of a larger internal automation effort. Phase 1's goal is narrow: give the user a safe sandbox copy of a staging page they can visually poke at, without any risk of touching production WordPress.

---

## 3. Non-Goals (explicit)

- **No live editing of the real WordPress site.** Nothing in this app ever writes to the staging server. The snapshot is a disposable, in-memory/local copy only.
- No Figma API integration yet (Phase 2).
- No annotation tools or screenshot capture yet (Phase 3).
- No Google Sheets / CWSA auto-fill yet (Phase 4).
- No JS execution from the captured site (see §5.2 — scripts are stripped intentionally).
- No multi-user/collaboration features. Single-user, local desktop tool.

---

## 4. Tech Stack

| Layer | Choice | Notes |
|---|---|---|
| Application shell | **Electron** (latest stable) | Chosen for consistent Chromium rendering across OSes |
| Renderer framework | **React + Vite** | Fast dev loop, standard component model |
| Language | **TypeScript** throughout (main + renderer) | |
| Editing canvas | **GrapesJS** (core, MIT license) | Do not build a custom resize/style-panel system from scratch |
| Styling (app chrome, not captured site) | CSS Modules or Tailwind — agent's choice, but must support the design direction in §7 | |
| Packaging | electron-builder | Not required to produce installers in Phase 1, but structure the project so it's possible later |
| IPC | Electron's `contextBridge` / `ipcRenderer` with a typed preload script | No `nodeIntegration: true` in the renderer — security best practice |

---

## 5. Functional Requirements — Phase 1

### 5.1 Input: staging site URL

- App has a simple entry screen: a text input for a staging site URL, and a "Capture" button.
- On submit, the main process fetches the page's rendered HTML.
  - Since staging sites are typically behind basic auth or a login, the app should open the URL in a hidden/background `BrowserWindow` (Electron), let it fully load (including any WordPress/Elementor/Gutenberg dynamic rendering), and then pull `document.documentElement.outerHTML` from that window via `webContents.executeJavaScript`.
  - This sidesteps needing to fetch and re-render HTML manually, and preserves cookies/session for authenticated staging environments (the background window shares or uses its own session/partition — agent's choice, but must support logging into staging if prompted).

### 5.2 DOM Snapshot / Freezing

Once the raw HTML is captured, the agent must produce a "frozen" version before loading it into the editor:

1. **Rewrite relative URLs to absolute.** Any `src`/`href` pointing at relative paths (`/wp-content/...`, `/assets/...`) must be rewritten to fully-qualified URLs against the original staging domain, so stylesheets, fonts, and images still resolve.
2. **Strip all `<script>` tags.** No JS from the original site should execute in the snapshot. This is intentional — Phase 1 is visual/layout QA only, not functional QA. CSS-driven behavior (fonts, colors, spacing, responsive breakpoints via media queries) all still work without JS.
3. **Force-resolve lazy-loaded assets.** Many WordPress themes/page-builders lazy-load images via `data-src` or similar attributes and a JS observer. Since JS is stripped, the agent should do a pass that copies any common lazy-load attribute (`data-src`, `data-srcset`, `data-lazy-src`, etc.) into the real `src`/`srcset` before stripping scripts, so images aren't blank in the snapshot.
4. **Preserve inline `<style>` tags and linked stylesheets as-is** (after URL rewriting) — these carry real CSS custom properties, `@font-face` rules, and breakpoint logic that the snapshot depends on.
5. Output of this stage: a single self-contained HTML string (the "snapshot") ready to hand to GrapesJS.

### 5.3 Loading the Snapshot into GrapesJS

- Initialize GrapesJS in a sandboxed iframe within the renderer, using the snapshot HTML as the starting canvas (`fromElement`/`components` config, whichever fits GrapesJS's API for loading raw HTML+CSS).
- The snapshot must render responsively inside the GrapesJS canvas — i.e., resizing the canvas viewport should still trigger the original page's real media queries, so breakpoint behavior is checkable.
- User must be able to:
  - Click to select any element in the snapshot (GrapesJS's default layer/selector behavior).
  - See and edit that element's computed styles: font family, font size, color, spacing (margin/padding), width/height — via GrapesJS's built-in Style Manager panel.
  - Resize elements via drag handles (GrapesJS's default resize behavior is acceptable — 8-point handles).
  - See a layer tree of the page structure (GrapesJS's Layer Manager).
- None of these edits persist anywhere outside the running app session in Phase 1 (no save-to-disk requirement yet — that can be a fast-follow, but is not a blocking requirement for this phase).

### 5.4 Session Lifecycle

- Capturing a new URL replaces the current snapshot (single working snapshot at a time is fine for Phase 1).
- No requirement yet to cache/store multiple snapshots — that's a later concern.

---

## 6. Architecture Notes

```
/src
  /main            → Electron main process
    index.ts       → app bootstrap, BrowserWindow creation
    capture.ts      → hidden-window HTML capture logic
    snapshot.ts      → DOM freezing/rewriting logic (script stripping, URL rewriting, lazy-load resolution)
    preload.ts       → contextBridge-exposed API surface for renderer
  /renderer        → React + Vite app
    /components
      CaptureScreen.tsx    → URL input + capture trigger
      EditorWorkspace.tsx  → GrapesJS host, main editing view
    /grapesjs
      init.ts               → GrapesJS config/init logic, loading snapshot HTML
    App.tsx
    main.tsx
  /shared          → types shared between main/renderer (e.g. IPC message shapes)
```

- Main ↔ renderer communication: renderer requests a capture via IPC (`capture:start`, passing the URL), main process handles the hidden-window load + snapshot freezing, then returns the frozen HTML string back over IPC (`capture:complete`). Renderer then feeds that string into GrapesJS.
- Keep the freezing logic (§5.2) in main process, not renderer — it deals with a full untrusted HTML document and is cleaner to reason about outside the React render tree.

---

## 7. Design Direction (UI/UX)

The app's own chrome (not the captured site content, which keeps its native styles) should read as a **sleek, modern design tool in the visual language of Figma**:

- Dark, neutral workspace background (Figma-style near-black/dark-gray canvas area) with the snapshot rendered in a light "page" surface floating in that canvas — mirrors Figma's canvas-vs-frame visual relationship.
- Minimal, icon-driven toolbar (not label-heavy) for switching modes/tools.
- A right-hand properties/style panel (mirroring GrapesJS's Style Manager) styled to match Figma's inspector panel: compact rows, clear typography hierarchy, generous use of subtle dividers rather than boxed sections.
- Left-hand layer tree panel (GrapesJS's Layer Manager), styled consistently with the right panel.
- Restrained accent color for selection states/handles (a single blue akin to Figma's selection blue is a safe default) — avoid multiple competing accent colors.
- Typography: a clean UI sans (Inter or similar system-ui stack) for all app chrome, distinct from whatever fonts the captured site itself uses.
- No skeuomorphic elements, no heavy drop shadows/gradients — flat, precise, high information density without feeling cluttered.

The agent should consult the `frontend-design` and `distinctive-frontend` skills when implementing this chrome, and treat GrapesJS's default UI as a starting point to restyle, not a final look to ship as-is.

---

## 8. Acceptance Criteria (Phase 1 "done")

1. User can enter a staging site URL and trigger a capture.
2. App produces a frozen, script-free HTML snapshot with working images, fonts, and CSS (including responsive breakpoints).
3. Snapshot loads into a GrapesJS canvas styled in the Figma-like direction described in §7.
4. User can select any element, see its computed styles, and adjust font size, font family, color, and spacing/sizing via the Style Manager panel.
5. User can resize elements via drag handles.
6. Resizing the canvas/viewport correctly triggers the snapshot's real media queries.
7. None of the above ever sends a write request to the original staging site.

---

## 9. Open Questions for the User (do not silently assume)

- Does staging typically require login (basic auth / WP login) that the hidden capture window will need to handle interactively?
- Should there be a "reset snapshot" button to discard edits and re-capture, or is closing/reopening the app sufficient for Phase 1?
