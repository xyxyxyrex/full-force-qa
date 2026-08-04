# Automate Workspace — Implementation and Architecture

## 1. Purpose

`Automate` is Full Force QA's visual-regression and semantic-layout workspace. It compares a selected full-page Figma frame against a fresh rendering of the project's staging URL in authenticated Electron Chromium.

The feature is designed for QA teams validating WordPress, Elementor, Oxygen, and other staging implementations where Figma layer names do not correspond to HTML tags, CSS classes, or CMS component names.

Automate combines two independent signals:

1. **Visual comparison** — compares rendered pixels after vertically registering the long Figma and Chromium images.
2. **Semantic layout comparison** — matches Figma text layers to visible live-DOM elements by content, geometry, context, and element type.

This hybrid approach is intentional. Pixel comparison catches visual changes that have no useful DOM representation, while semantic comparison produces understandable findings such as font-size, position, missing-text, and full-page-height differences.

Automate is a read-only QA facility. It does not save changes to or mutate the staging server. Temporary page-state changes made during capture—scroll position, animation state, and fixed-element visibility—exist only inside the local Chromium renderer and are restored after capture.

---

## 2. User Workflow

1. Open a project containing a staging URL.
2. Open the **Automate** workspace using the icon in the workspace switcher.
3. Connect a Figma personal access token if one has not already been stored.
4. Enter or reuse the project's Figma design URL.
5. Select **Load frames**.
6. Select the intended full-page frame.
7. Select **Run comparison**.
8. Review:
   - visual similarity;
   - changed-pixel percentage;
   - high-priority finding count;
   - total semantic-check count;
   - Diff, Figma, and Live full-page views;
   - individual finding evidence.
9. Select a finding to open a focused Figma-versus-live comparison with bounding boxes, coordinates, dimensions, a connector arrow, and calculated deltas.

The staging page is rendered in a real Electron `<webview>`. It is not reconstructed from fetched HTML and does not use GrapesJS. This preserves the browser's normal CSS cascade, JavaScript behavior, cookies, fonts, images, WAF interaction, and responsive layout as closely as Electron permits.

---

## 3. Technology Stack

### Application

| Layer | Technology | Responsibility |
| --- | --- | --- |
| Desktop runtime | Electron 35 | Chromium rendering, webview hosting, session access, IPC, secure storage |
| Frontend | React 18 + TypeScript | Automate controls, progress, result presentation, finding evidence |
| Build | electron-vite + Vite 6 | Main, preload, and renderer builds |
| Packaging | electron-builder | Desktop distribution and bundled worker resources |
| Image stitching | Sharp | Native PNG decoding, compositing, and full-page encoding in the main process |
| Browser automation | Chrome DevTools Protocol through Electron `webContents.debugger` | Device emulation, verified scrolling, screenshots, and live-DOM extraction |

### Visual-analysis worker

| Technology | Responsibility |
| --- | --- |
| Python 3 | Worker runtime during development |
| NumPy | Image and coordinate arrays |
| OpenCV (`opencv-python-headless`) | Resize, edge extraction, template matching, remapping, morphology, contours, and heatmap rendering |
| scikit-image | Structural Similarity Index (`SSIM`) |
| PyInstaller | Produces the distributable `visual-compare` worker executable |

### Principal implementation files

| File | Responsibility |
| --- | --- |
| `src/renderer/src/components/AutomateWorkspace.tsx` | Workspace state, Figma controls, comparison orchestration, semantic matching, JS visual fallback, and evidence UI |
| `src/renderer/src/components/AutomateWorkspace.css` | Automate layout and theme-aware presentation |
| `src/renderer/src/components/EditorWorkspace.tsx` | Workspace registration, navigation icon, project URL/Figma URL handoff |
| `src/main/index.ts` | Token storage, Figma REST calls, CDP capture, Sharp stitching, Python worker lifecycle, and IPC handlers |
| `src/preload/index.ts` | Narrow renderer-to-main Automate API bridge |
| `src/shared/types.ts` | `ElectronAPI` types for the Automate IPC surface |
| `python/visual_compare.py` | OpenCV/SSIM comparison engine |
| `python/requirements.txt` | Python worker dependencies |
| `package.json` | Worker build, application build, and packaged-resource configuration |

---

## 4. High-Level Architecture

```text
┌──────────────────────── React renderer ────────────────────────┐
│ AutomateWorkspace                                              │
│  • selects Figma frame                                         │
│  • hosts authenticated staging webview                         │
│  • orchestrates progress/cancellation                          │
│  • performs semantic matching                                  │
│  • renders scores, images, findings, and evidence              │
└────────────────────────────┬────────────────────────────────────┘
                             │ typed preload IPC
┌────────────────────────────▼────────────────────────────────────┐
│ Electron main process                                          │
│  • encrypted Figma token                                       │
│  • Figma REST API                                              │
│  • CDP capture of the guest webContents                        │
│  • Sharp tile stitching                                        │
│  • Python worker spawning/cancellation                         │
└───────────────────────┬─────────────────────┬───────────────────┘
                        │                     │
               ┌────────▼────────┐   ┌────────▼─────────────────┐
               │ Figma REST API │   │ Python visual worker      │
               │ frame JSON/PNG │   │ OpenCV registration+SSIM │
               └─────────────────┘   └───────────────────────────┘
```

The renderer never receives the stored Figma token. Network calls requiring that token occur in the Electron main process.

---

## 5. Figma Integration

### 5.1 Authentication

Automate currently uses a **Figma personal access token**, not browser-cookie authentication or OAuth.

Required permission:

- `file_content:read`

Additional read scopes do not harm the integration, but the implemented endpoints only require access to file content and rendered images.

The token is stored at:

```text
<Electron userData>/figma-api-token.bin
```

Storage behavior:

- Electron `safeStorage` encrypts the token using the operating system's credential service.
- If OS-backed encryption is unavailable, Automate refuses to persist the token.
- The renderer can query whether a token exists, replace it, or clear it.
- The raw stored token is not exposed back to React.

### 5.2 Accepted URLs

The URL parser accepts Figma URLs whose path includes:

- `/design/<file-key>/...`
- `/file/<file-key>/...`
- `/proto/<file-key>/...`

If the URL includes `node-id`, hyphens are normalized to Figma's colon-separated node ID representation.

### 5.3 Frame discovery

Frame discovery requests:

```http
GET /v1/files/:fileKey?depth=2
```

The current selector exposes top-level nodes of these types when they have an absolute bounding box:

- `FRAME`
- `COMPONENT`
- `SECTION`

Each option records the node ID, node name, page name, type, width, and height. A `node-id` from the supplied URL is selected automatically when it is present in the discovered list; otherwise, the first comparable frame is selected.

### 5.4 Frame acquisition

Running a comparison requests the selected node structure and its rendered PNG in parallel:

```http
GET /v1/files/:fileKey/nodes?ids=:nodeId
GET /v1/images/:fileKey?ids=:nodeId&format=png&scale=1
```

The node JSON is used for semantic analysis. The scale-1 PNG is used for visual analysis and evidence.

### 5.5 Figma API error handling

The main process reports:

- HTTP status;
- Figma's response error when available;
- `Retry-After` information for rate limiting;
- Figma's upgrade link when returned by the API.

The frame render has a renderer-side 45-second timeout.

---

## 6. Chromium Capture Pipeline

### 6.1 Why the capture is tiled

Long staging pages cannot be captured reliably by simply resizing an Electron `<webview>` to the full document height. The host view can remain physically clipped to its original surface, producing:

- a short image instead of the full page;
- repeated copies of the first viewport;
- stale compositor frames;
- blank bands at tile boundaries.

Automate therefore captures verified viewport tiles through the Chrome DevTools Protocol and stitches them in the main process.

### 6.2 Capture dimensions

- Capture width equals the selected Figma frame width.
- The logical UI viewport is currently 1200 CSS pixels tall.
- Each actual CDP tile is capped at 1000 CSS pixels to remain below host-surface clipping observed on Electron/Windows.
- Tiles overlap by 12% of tile height, clamped to 64–180 pixels.
- `deviceScaleFactor` is forced to `1`.
- Mobile emulation is disabled.

This means a 1920×9573 Figma frame is compared with a live page rendered at 1920 CSS pixels wide. The live height is measured independently; it is not forced to equal 9573.

### 6.3 Capture sequence

`captureAutomatePage()` performs the following work:

1. Resolve the webview's guest `webContents` by ID.
2. Attach an Electron debugger using Chrome DevTools Protocol version `1.3` if another debugger is not already attached.
3. Enable the CDP `Page` domain.
4. Apply `Emulation.setDeviceMetricsOverride` with the Figma width and bounded tile height.
5. Pause Web Animations API animations.
6. Record the original scroll position and inline visibility of fixed/sticky elements.
7. force `scroll-behavior: auto` and move to the top.
8. Measure document width and height from the root and body scroll/offset dimensions.
9. Generate overlapping tile positions, including a final bottom-aligned tile.
10. For every tile:
    - hide fixed and sticky elements after the first tile so headers and banners are not repeated;
    - set `window`, root, and body scroll positions;
    - wait for two animation frames;
    - verify that Chromium reached the requested Y coordinate;
    - capture a PNG with `Page.captureScreenshot`;
    - hash the PNG and reject an identical consecutive tile.
11. Perform semantic DOM extraction after the complete scroll pass so lazy-rendered and footer content is present.
12. Stitch the PNG buffers with Sharp over an opaque white RGBA canvas.
13. Return the PNG data URL, document dimensions, semantic nodes, tile count, and capture mode.
14. Restore fixed/sticky visibility, animation playback, scroll behavior, scroll position, and device metrics.

Overlapping tiles are composited in document order. A later tile replaces the overlap at the bottom of the previous tile, preventing a blank Chromium compositor tail from appearing as a horizontal seam.

### 6.4 Capture guards

The current limits are:

- maximum document height: `24,000px`;
- maximum capture area: `45,000,000` pixels;
- renderer-side capture timeout: 90 seconds;
- scroll-position tolerance: 3 pixels;
- exact consecutive duplicate tiles: rejected.

These limits avoid excessive native memory usage and pathological Sharp allocations.

### 6.5 Session behavior

Automate navigates the staging URL in an Electron webview, so the rendered page uses Electron's Chromium session state rather than a separate HTTP scraper. Authentication must already be available to the session used by the project/webview. Pages that are public do not require WordPress authentication.

The comparison does not submit forms, invoke WordPress editing APIs, or persist any page mutations.

---

## 7. Live Semantic DOM Extraction

### 7.1 Extracted elements

The scanner considers:

- headings `h1`–`h6`;
- paragraphs and links;
- buttons and labels;
- list items;
- `span` and leaf-text `div` containers;
- definition lists;
- summaries and figcaptions;
- table heading/data cells;
- images and inputs;
- structural section, article, header, footer, nav, and main elements.

The broader leaf-text coverage is important for page builders that render visible labels such as footer column titles as generic `div` or `span` elements.

### 7.2 Text selection rules

For each element, the scanner attempts to obtain a concise semantic value:

1. `alt`, `aria-label`, or `title` for accessible/non-text elements;
2. direct text-node content;
3. the text of a single semantic child for list items;
4. `innerText` only when the element has no nested semantic text element;
5. accessible text as a fallback.

This avoids treating a large parent container as one concatenated text candidate while still supporting non-semantic page-builder markup.

Text is whitespace-normalized and capped at 500 characters.

### 7.3 Context and hierarchy

Each extracted node includes:

- tag and ARIA role;
- normalized text;
- image source where relevant;
- DOM path, including a limited set of IDs/classes;
- contextual section heading, nearby heading, ID, and ARIA label;
- document-relative rectangle;
- computed font size, font family, font weight, foreground/background color, text alignment, and positioning mode.

Coordinates are converted from viewport-relative `getBoundingClientRect()` values into document coordinates. The scan occurs after full-page scrolling, so elements in the footer retain correct page positions even though the browser is near the bottom when the scan runs.

### 7.4 Renderer fallback

The CDP capture normally returns the semantic nodes. `AutomateWorkspace` retains a renderer-side DOM extraction fallback for cases where the main-process result contains no nodes. That fallback also detects the largest nested vertical scroller and converts its child coordinates into document-relative positions.

---

## 8. Semantic Matching

### 8.1 No class-name dependency

Figma text layers are not matched to HTML classes, WordPress block names, Elementor widgets, or Figma layer names. Matching uses visible content and geometry.

### 8.2 Figma traversal

The selected Figma node tree is traversed recursively. Visible nodes with absolute bounding boxes contribute:

- text layers with non-empty normalized characters;
- nodes with image fills.

For text layers, the names of up to five ancestors are retained as design context.

To contain runtime on complex frames, the current semantic pass evaluates at most 240 Figma text layers.

### 8.3 Text similarity

Text normalization:

- converts to lowercase;
- removes non-alphanumeric separators;
- collapses whitespace.

The similarity function prioritizes:

1. exact normalized equality;
2. containment similarity for strings where one contains the other;
3. token overlap.

Non-exact candidates generally require:

- text similarity of at least `0.68`;
- at least eight characters in the shorter text;
- normalized geometric distance no greater than `0.20`.

### 8.4 Candidate scoring

The current score is approximately:

```text
score = text similarity × 0.64
      + geometric similarity × 0.27
      + context similarity × 0.09
      + heading affinity adjustment
```

Large Figma text receives a small positive affinity for live heading tags and a penalty for non-heading candidates.

The candidate must score at least `0.62`. Once matched, it is reserved so it cannot satisfy another design layer in the same comparison.

Design text with an exact unused live candidate is matched only against exact candidates before fuzzy alternatives are considered.

### 8.5 Semantic findings

Automate currently emits:

- **Missing design text** — no candidate passes the threshold;
- **Position mismatch** — matched element is displaced from its expected normalized position;
- **Font-size mismatch** — live and Figma font sizes differ by more than 1.5px;
- **Image count differs** — visible live image count differs from the Figma image-fill count;
- **Full-page height differs/matches** — live and design heights differ by more/less than 20px;
- **No material semantic mismatches detected** — emitted when no other semantic finding exists.

Position severity is based on offset relative to page width. Font-size severity increases for differences greater than 4px.

---

## 9. Visual Comparison Worker

### 9.1 Process boundary

Visual analysis runs outside the Electron renderer so OpenCV and large image arrays do not block React or Chromium.

During development, Electron starts:

```text
python python/visual_compare.py --design <temp PNG> --live <temp PNG>
```

In packaged builds it starts:

```text
resources/visual-worker/visual-compare[.exe]
```

Input data URLs are decoded into a unique temporary directory. The worker writes one JSON object to stdout. Temporary data is deleted after completion, failure, cancellation, or timeout.

### 9.2 Preprocessing

Both images are decoded as BGR images and resized to a common working width:

```text
min(960, design width, live width)
```

Aspect ratio is preserved independently for each long image.

### 9.3 Vertical section registration

Long pages often contain the same sections at different Y positions. Comparing raw rows would mark everything after one height change as different.

The worker therefore:

1. converts both images to grayscale edges using Gaussian blur and Canny detection;
2. samples full-width horizontal strips from the design;
3. searches near the strip's proportional expected position in the live image;
4. uses normalized template correlation to choose a live Y coordinate;
5. rejects weak/non-monotonic anchors;
6. pins the first and final image rows as boundary anchors;
7. interpolates a design-row-to-live-row mapping;
8. remaps the live page into the design's vertical coordinate system.

The returned anchors are also used by React to map OpenCV difference regions back onto the original live screenshot.

### 9.4 SSIM and changed pixels

After alignment, the worker calculates grayscale Structural Similarity (`SSIM`) with a full similarity map.

```text
change map = 1 - SSIM map
changed pixel = change map > 0.20
```

The binary change mask is cleaned with morphological close/open operations. External contours become candidate difference regions after a minimum-area filter.

The worker returns:

- overall SSIM similarity percentage;
- changed-pixel percentage;
- heatmap PNG;
- up to 120 difference regions;
- vertical alignment anchors;
- engine identifier `opencv-ssim`.

The renderer adds at most eight sufficiently large difference regions to the human-readable finding list.

### 9.5 JavaScript fallback

If Python/OpenCV is unavailable, crashes, times out, or returns invalid JSON, Automate falls back to a renderer canvas comparison:

- resize to a bounded comparison canvas;
- compare RGB channel deltas;
- create a simple colored diff image;
- calculate approximate changed-pixel and similarity percentages.

The fallback does not provide section registration, contours, or alignment anchors and is therefore less accurate for long pages.

---

## 10. Finding Evidence UI

Selecting a finding replaces the overview image with a focused evidence canvas.

The canvas:

- crops the Figma and live images around their respective regions;
- labels the two sides **Figma Expected** and **Live Chromium**;
- draws colored bounding boxes;
- displays box width and height;
- displays document X and Y coordinates;
- draws a dashed connector arrow;
- reports applicable deltas for X, Y, width, height, and font size;
- displays the matched text/context label.

Findings without comparable rectangles can still appear in the finding list, but their evidence button is disabled or has only the available side.

---

## 11. IPC Contract

The preload exposes only these Automate-related calls:

| Method | Main-process channel | Purpose |
| --- | --- | --- |
| `figmaTokenStatus()` | `figma:token-status` | Report whether an encrypted token exists |
| `setFigmaToken(token)` | `figma:set-token` | Store, replace, or clear the token |
| `listFigmaFrames(url)` | `figma:list-frames` | Read comparable top-level frames |
| `getFigmaFrame(url, nodeId)` | `figma:get-frame` | Retrieve node JSON and rendered PNG |
| `captureAutomatePage(id, width, height)` | `automate:capture-page` | Capture and semantically scan staging Chromium |
| `compareVisuals(jobId, design, live)` | `automate:visual-compare` | Run the native/Python visual worker |
| `cancelVisualComparison(jobId)` | `automate:visual-cancel` | Terminate an active worker |

All main handlers convert thrown failures into structured `{ success: false, error }` responses where appropriate.

---

## 12. Progress, Timeouts, and Cancellation

The UI reports staged progress for:

- staging readiness;
- Figma rendering;
- verified Chromium capture;
- semantic layout reading;
- OpenCV registration;
- SSIM and contours;
- Figma/live semantic matching.

Important timeouts:

| Operation | Timeout |
| --- | ---: |
| Staging readiness check | 12 seconds |
| Figma frame render | 45 seconds |
| CDP full-page capture | 90 seconds |
| Main-process visual worker | 90 seconds |
| Renderer wait for visual worker | 95 seconds |
| JavaScript visual fallback | 30 seconds |

Every run receives a project/run job ID. Cancelling:

- increments the renderer run generation so late results are ignored;
- requests termination of the active Python process;
- clears visible progress and reports cancellation.

---

## 13. Security and Privacy

- The Figma token is encrypted with Electron `safeStorage`.
- The token is used only in the main process.
- Figma API responses and staging screenshots are held in application memory during comparison.
- Temporary worker PNGs are deleted after the worker settles.
- Automate does not upload staging screenshots to Figma.
- Visual comparison is local.
- The staging page is opened normally in Chromium and may itself contact its configured third-party services.
- A compromised staging page still runs inside an Electron webview; preload exposure should remain narrow and no unrestricted Node API should be exposed to guest content.

---

## 14. Build and Distribution

### Development

Install JavaScript and Python dependencies, then run:

```powershell
npm install
python -m pip install -r python/requirements.txt
npm run dev
```

### Application build

```powershell
npm run build
```

### Packaged visual worker

```powershell
npm run build:visual-worker
```

PyInstaller creates a one-file worker under `resources/visual-worker`. The directory is included by `electron-builder` through `extraResources`.

### Full distributable

```powershell
npm run build:dist
```

This builds the worker first, then Electron's main/preload/renderer bundles, then the desktop distribution.

Changes to `src/main/index.ts` or `src/preload/index.ts` require a full Electron restart; React hot reload alone is insufficient.

---

## 15. Constraints and Known Limitations

### Figma constraints

- The token must have access to the selected file.
- REST API rate limits and entitlement behavior are controlled by Figma and the account/seat plan.
- Frame discovery currently inspects only depth 2 and top-level frame/component/section nodes.
- The implementation renders at Figma scale 1.
- Prototype transitions, interactive variants, hover states, video, and runtime prototype logic are not reproduced by the static frame export.
- Hidden Figma layers are excluded from semantic traversal.
- Text broken into many Figma layers may produce several semantic candidates even when the browser renders one combined text node.

### Browser and capture constraints

- The page must finish enough loading for stable dimensions and content.
- Network-dependent lazy content that appears more than two animation frames after scrolling can still be absent or visually unsettled.
- Infinite-scroll pages do not have a stable full-page boundary.
- Pages taller than 24,000px or exceeding 45 million capture pixels are rejected.
- Fixed/sticky elements are shown in the first tile and hidden in subsequent tiles. A design intentionally repeating sticky content at multiple positions will not be represented that way.
- CSS animations exposed through the Web Animations API are paused; timer-driven, video, WebGL, or canvas animation may continue.
- Cookie banners, chat widgets, admin bars, A/B tests, timestamps, ads, and personalization can create legitimate visual differences.
- The capture uses CSS pixels at device scale factor 1. It does not reproduce every physical monitor's DPR or OS text rasterization.
- Custom scroll containers are better supported by the renderer fallback than the primary window-scrolling CDP path. Pages whose entire layout scrolls only inside a deeply nested container may require further capture handling.

### Semantic constraints

- Semantic matching does not understand business meaning; it uses text, location, context, and element type.
- Text rendered only into canvas, WebGL, video, CSS generated content, or inaccessible cross-origin iframes is visible to pixel comparison but not available to DOM matching.
- Closed shadow DOM cannot be inspected.
- Image comparison counts Figma image fills and visible HTML `img` nodes; CSS backgrounds, SVG artwork, canvas images, and picture composition can cause count differences.
- Repeated labels such as “Learn,” “Products,” or “Read more” are disambiguated using geometry/context, but highly repetitive layouts remain ambiguous.
- Matching reserves a live candidate after use. A single browser element intentionally representing several Figma text layers can therefore create missing-text findings.
- Position matching currently normalizes by total page height. Large inserted/removed sections can influence expected positions even though the visual worker performs non-linear vertical registration.
- Font comparison currently focuses on font size; family, weight, line height, letter spacing, and color are extracted but are not all emitted as dedicated findings.

### Visual-analysis constraints

- SSIM measures structural pixel similarity, not design correctness.
- Anti-aliasing, font rendering, subpixel placement, image compression, and dynamic content affect similarity.
- Full-width strip registration assumes enough shared horizontal structure between design and live page.
- Reordered sections, very different backgrounds, or sparse pages can produce weak alignment anchors.
- The JavaScript fallback is intentionally simpler and should not be treated as equivalent to `opencv-ssim`.
- Scores are QA indicators, not pass/fail guarantees. Findings require human review.

---

## 16. Troubleshooting

### Connect does not respond

- Confirm the application was fully restarted after main/preload changes.
- Confirm OS secure credential storage is available.
- Confirm the personal access token is non-empty and valid.

### Load frames fails

- Confirm the URL is a Figma design/file/proto URL.
- Confirm the token has `file_content:read` and access to the file.
- Check for Figma rate-limit or entitlement messages.
- Confirm the desired frame is top-level enough to appear at API depth 2.

### Run comparison is disabled

- Load frames and select a frame first.
- Ensure the staging webview has reached DOM-ready.

### Capture stops or reports the wrong scroll position

- Verify the page has a conventional document/window scroller.
- Check for scroll locking, modal overlays, or an application-level nested scroller.
- Confirm the document is below the configured area/height limits.

### Repeated tiles or horizontal seams

- Confirm the latest main-process build is running, not only a hot-reloaded renderer.
- The current implementation uses bounded overlapping tiles; seeing the former expanded-surface errors indicates an outdated process/build.
- Check for page scripts that forcibly reset scroll position or continuously replace the document.

### Footer text is reported missing although visible

- Confirm a comparison was run after the post-scroll semantic-scan implementation.
- Inspect whether the text lives in canvas, cross-origin iframe, generated CSS content, or closed shadow DOM.
- Inspect whether Figma split the label into several layers or used materially different characters.

### OpenCV is unavailable

- Development: install `python/requirements.txt` and confirm the configured Python command works.
- Packaged app: confirm `resources/visual-worker/visual-compare.exe` exists on Windows.
- Automate will fall back to the JavaScript diff, but alignment and region quality will be reduced.

---

## 17. Recommended Validation Matrix

Before releasing capture or matching changes, test at least:

| Case | Expected result |
| --- | --- |
| Public static page | Full capture without authentication |
| Authenticated WordPress preview | Existing session is respected |
| 8,000–12,000px landing page | No repeated tiles or horizontal seams |
| Sticky navigation | Appears once, not once per tile |
| Lazy-loaded footer | Footer visible and represented in semantic nodes |
| Repeated footer/header labels | Geometry/context chooses the correct candidate |
| Figma/live height mismatch | Height finding and usable registered visual diff |
| Inserted live section | Downstream content remains reasonably aligned |
| Missing Python worker | JavaScript fallback completes and is identified |
| Cancel during OpenCV | Worker terminates and late results are ignored |
| Figma rate limit | Useful API error and retry information |
| Page over capture limit | Explicit bounded-size error, no crash |

---

## 18. Extension Points

High-value future improvements include:

1. OAuth-based Figma authorization for managed multi-user deployment.
2. Recursive/paginated Figma frame discovery beyond depth 2.
3. A nested-scroll-container CDP capture mode.
4. Network-idle and font-ready stabilization before capture.
5. Configurable masks for dynamic areas such as timestamps, chat, video, and ads.
6. Dedicated font-family, font-weight, color, line-height, radius, and spacing findings.
7. OCR fallback for text visible only in pixels.
8. Shadow DOM traversal where roots are open.
9. Better reconciliation of one live text node with several Figma text layers.
10. Persistent comparison baselines and historical trend reports.
11. User-configurable severity thresholds and ignored regions.
12. Automated CI/headless comparison using the same main-process capture and worker contracts.
13. Exportable HTML/PDF QA reports containing evidence images and finding metadata.

Any extension should preserve the central architecture: render the real site in Chromium, keep credentials and native work in the main process, treat visual and semantic signals separately, and present evidence rather than only a score.

---

## 19. Current Definition of Success

An Automate run is technically successful when:

- the selected Figma node and scale-1 PNG are retrieved;
- Chromium reaches and verifies every requested tile position;
- no exact repeated consecutive tile is returned;
- Sharp produces a full live-page PNG;
- the semantic scanner returns document-coordinate nodes or a valid empty result;
- OpenCV completes or the JavaScript fallback completes;
- the UI receives scores, images, and findings without accepting results from a cancelled/stale run.

A technically successful run is not automatically a QA pass. Final acceptance remains a human decision based on the visual evidence, semantic findings, project requirements, and known dynamic-content exceptions.
