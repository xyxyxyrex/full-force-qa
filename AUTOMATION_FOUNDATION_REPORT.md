# Automation foundation refactor

Date: 2026-09-09. Implemented directly in the main checkout, on `main`, starting from `45fe121` (1.4.1). This is the first foundation phase of the supplied architectural plan, not completion of every later phase. No push, release, installer publication, or Cloudflare deployment was performed.

## Inspection and migration map

| Existing path / problem | Foundation change |
| --- | --- |
| Main-process capture silently clamped viewport height to 1000, swallowed readiness timeouts, and truncated DOM text | Capture isolated; requested viewport retained; readiness/native-size failures explicit; full text and unique DOM paths; semantic snapshot restored to document top. |
| Figma structure/render fetched independently; no cache | Structure and 1× full-bounds render pinned to the same version; render dimensions validated. No cache implied. |
| Python resizing, template/ORB anchors, forced bottom endpoint, vertical remapping, local offset search and SSIM | Automation caller removed. Typed IPC routes only to a Node Pixelmatch worker. Resized renderer fallback removed. |
| Semantic 240-text-node cap, drift/global-offset subtraction, adjusted paragraph boxes, score-derived confidence | Full traversal and native geometry. Contextual/Hungarian assignment retained; repeated text and merge/split candidates stay ambiguous. |
| Unmatched text asserted missing; image counts asserted asset defects | Unresolved correspondence is ambiguous; image identity/cropping is unavailable. No inferred cause. |
| Scores, charts and independently rescaled evidence crops | Shared-origin Design / Live / Diff / Slider, coverage, explicit states, measured values, collapsed details, pagination and count-only history. |

## Files changed

- `src/shared/automation.ts`, `automationTolerance.ts`, `automationText.ts`, `automationFindings.ts`: evidence/result contracts, tolerances, text/ID helpers, pixel and dimension findings.
- `src/main/automation/{pixelDiff,clusterDiff,imageLoader,worker,runComparison}.ts`: native comparison, connected regions, PNG handling and cancellable worker.
- `src/main/automation/{capture,captureNormalization}.ts`: capture isolation and explicit guardrails.
- `src/main/index.ts`, `src/preload/index.ts`, `src/shared/types.ts`: migrated IPC, version-pinned Figma rendering and compatible history types.
- `src/renderer/src/automation/{correspondence,geometry,styles,colors,ComparisonView}.ts[x]`: separate matching, measured properties and preview.
- `src/renderer/src/utils/visualCompare.ts`: semantic orchestration and annotation bridge.
- `src/renderer/src/components/AutomateWorkspace.tsx` and `.css`: Automation-only UI cleanup.
- `src/main/automation/pixelDiff.test.ts`, `src/renderer/src/automation/styles.test.ts`, `src/renderer/src/utils/visualCompare.test.ts`: regression tests.
- `scripts/test-automation-electron.cjs`, `scripts/fixtures/automation-ui.tsx`: local hidden-window capture/worker/UI smoke checks.
- `electron.vite.config.ts`: builds `out/main/automation-worker.js`; bundles Pixelmatch for CommonJS compatibility.
- `package.json`, `package-lock.json`: Pixelmatch/PNGJS/types, smoke command, installer exclusion for local smoke artifacts.
- `.github/workflows/ci.yml`: runs Electron smoke after the Windows desktop build.
- `README.md`: focused Automation behavior/dependency/limitation updates.

## New behavior

States are `pass`, `fail`, `visual`, `ambiguous`, `ignored`, `unavailable`. Evidence strength is `deterministic`, `strong`, `visual`, `ambiguous`, `unverified`. Severity, correspondence quality, magnitude and coverage are separate.

Pixel-only findings say **Visual difference detected**, without guessing padding, margins or font causes. Width/height differences are separate findings even with a matching overlap. A passed check applies only to that property or overlap, not whole-page approval.

Typography reports computed/declaration values and numeric deltas. Missing values, unresolved line heights, translucent paint context and failed font-availability checks are not passes. Repeated text alone cannot establish a verified mapping. Annotation creation remains explicit and excludes ambiguous/unavailable findings.

Historical conformance scores remain optional for reading older saved summaries, but are neither produced nor displayed.

## Pixel and capture guarantees

- No resizing, stretching, warping, image-anchor registration, bottom alignment or local offset compensation.
- Native top-left overlap only; excess area is counted outside coverage.
- Pixel threshold `0.1`, `includeAA: false`; two-pixel processing halos preserve AA decisions at tile boundaries.
- Exact binary mask and 8-connected components; no erosion, dilation, minimum-area cutoff or silent result truncation.
- Display-only zoom uses a common origin and scale across views.
- Requested Chromium viewport, device scale 1 and browser zoom 1. Original zoom is restored. Hiding scrollbar paint does not expand real content geometry.
- Readiness errors, changing page dimensions, incorrect raster size and horizontal overflow stop capture explicitly.
- Concurrent capture on the same webview is rejected during cleanup. Pixel cancellation/timeout is failure, never fallback success.

## Verification

- `npm test`: **154 tests passed across 17 files**, including the Figma one-pixel export-rounding regression tests added for 1.4.2. Chromium tile validation remains exact and original export dimensions are retained.
- Tests cover identical screenshots; width/height mismatch; an isolated pixel; 1/4/8/16px displacement; inserted/removed vertical content; AA-only edge changes; a 1920×6000 screenshot; repeatable masks/regions; and more than 120 regions.
- Semantic tests preserve uniform 4/8/16px shifts and downstream 62px shifts, process 260 text nodes, and keep repeated/merged text ambiguous.
- Existing color, Hungarian, annotation, capture-geometry and unrelated tests remain passing. Tests requiring drift correction or confidence fields were intentionally replaced.
- `npm run build`: main, preload, renderer and the Node worker build successfully.
- `npx tsc --noEmit -p tsconfig.node.json`: passes.
- Renderer type checking reports **nine pre-existing errors** in `EditBetaWorkspace.tsx`, `EditorWorkspace.tsx`, and `grapesjs/init.ts`. A read-only compiler run against original HEAD sources reproduced the same nine diagnostics. No new Automation errors.
- `npm run test:automation:electron`: passes on Windows with hidden software-rendered windows. Checks actual 800×1200 / 3200px capture, repeatability, 8px DOM displacement, the built worker, cancellation, invalid PNG, overflow failure/cleanup, renderer comparison, view switching, slider interaction, finding navigation, ignore/restore and annotation creation.
- UI smoke uses mocked Figma/API responses and real local capture/diff fixtures. It does **not** claim a live Figma-account run or a newly installed NSIS build.
- The smoke check also packages the worker and PNGJS into an ASAR archive and executes them in Electron; changed-pixel counts and regions match the unpacked run exactly.
- Worker output is included by existing installer rules. New smoke artifacts use the system temp directory; initial local smoke artifacts under `out` are explicitly excluded from installers.
- Scoped diff review leaves pre-existing logs, the supplied plan, project-history files and unrelated workspaces alone.

## Retained legacy and deferred work

- Python/OpenCV source, requirements, PyInstaller scripts, legacy resources and the worker CI job remain for a separate packaging migration. No Automation runtime caller/fallback remains.
- No immutable disk design cache, imported-image mode, offline fallback or automatic rate-limit retry. Figma 429 remains explicit source unavailability; version pinning is not caching.
- Full container hierarchy matching, repeated-label disambiguation, rich-text/font-run identity, image identity/crop validation, design variables, transform-aware geometry and advanced paint/border checks remain later phases.
- Finding triage exists; ignored-region masks and baseline snapshot/version management do not.
- Explicit resource limits: 45 million pixels per image; 24,000px live capture height; 200,000 connected regions; 60-second capture deadline; 90-second pixel-worker deadline. Limits produce unavailable comparisons, not truncated success.
- Fixed/sticky content is included only in the first viewport and suppressed later. Nested scrolling, video/canvas, CSS background-image readiness, changing widgets and layout changes that preserve total dimensions need richer capture coverage.
- Cancellation during retrieval/capture discards the run while in-flight work finishes or times out and cleans up. Pixel-worker cancellation terminates that worker.
- Correspondence is ranking, not identity proof or probability. Conservative ambiguity can reduce strong mappings; large ambiguous Hungarian bands can still be expensive.
- Text-frame bounds and CSS line-box bounds can differ legitimately. Geometry is measured without pretending to infer a CSS cause.

References: [Pixelmatch options](https://github.com/mapbox/pixelmatch), [Figma render/version/full-bounds parameters](https://developers.figma.com/docs/rest-api/file-endpoints/).
