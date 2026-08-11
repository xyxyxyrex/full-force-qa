# Rebrand spec: QA Snapshot Editor → Parity

Rename the product from "QA Snapshot Editor" to "Parity" across the codebase, UI, and build artifacts. This document is the source of truth for the new brand — apply it everywhere the old name or its assets currently appear.

## 1. Naming

- Product name: `Parity` (capitalized in prose/UI titles)
- Lowercase lockup (logo, wordmark, marketing): `parity`
- Package / bundle identifier: replace `qa-snapshot-editor` → `parity` (or org-appropriate reverse-DNS equivalent, e.g. `com.yourorg.parity`)
- Executable / process name: `Parity`
- Window title, app menu title, About dialog: `Parity`
- Do not keep "QA Snapshot Editor" as a subtitle or tagline unless explicitly requested — it's a full rename, not a rebrand-with-old-name-retained.

Find-and-replace scope: package.json `name`/`productName`, Electron builder config (`appId`, `productName`, `nsis`/`dmg` titles), window titles, splash screens, About/Settings panels, README, CHANGELOG headers, log file prefixes, and any user-facing strings referencing the old name.

## 2. Logo mark

Signature concept: two horizontal rounded bars stacked with a gap — a visual shorthand for "design layer" and "live layer" brought into alignment (an implied equals sign, without being a literal `=` glyph).

- Bars: `#1D9E75` (Match teal), `4px` corner radius, equal width, centered in a `14px`-radius rounded square container
- Container (dark/default): `#1C2321` (Ink)
- Container (light variant): `#EDEFEE` (Paper)
- Minimum clear space: 25% of icon width on all sides
- Do not recolor the bars for themed icon variants — teal stays constant; only the container swaps between Ink and Paper

## 3. Asset files (already generated, ready to drop in)

| File | Use |
|---|---|
| `favicon.ico` | Browser tab icon, 16/32/48 multi-res |
| `parity-32.png` | Taskbar / small UI |
| `parity-192.png` | Android / PWA icon |
| `parity-512.png` | App store / high-res icon, dark variant |
| `parity-180.png` | Apple touch icon |
| `parity-light-512.png` | High-res icon, light-background variant |
| `parity-favicon.svg` | Vector source — re-export any size not covered above |

Electron packaging notes:
- Windows: build `.ico` from `parity-512.png` (multi-res 16–256px) for the installer/taskbar icon
- macOS: build `.icns` from `parity-512.png`
- Linux: use `parity-512.png` directly for `.desktop` icon reference

## 4. Color palette

| Name | Hex | Role |
|---|---|---|
| Ink | `#1C2321` | Primary dark surface, default icon background, primary text on light |
| Paper | `#EDEFEE` | Primary light surface, text on dark |
| Match | `#1D9E75` | Logo mark, "matches design" state, success/parity-confirmed UI |
| Diff | `#D85A30` | "Mismatch found" state, diff/error UI, alerts |
| Slate | `#5F5E5A` | Secondary text, muted UI, structural borders |

Usage rule: Match and Diff are semantic, not decorative — reserve them for actual comparison-result states (badges, diff counts, status dots) so their meaning stays consistent between the logo and the live UI. Don't use them for arbitrary accents elsewhere.

## 5. Typography

| Role | Typeface direction | Used for |
|---|---|---|
| Display | Geometric grotesk, medium weight (e.g. Space Grotesk, General Sans) | Wordmark, page titles, empty-state headlines |
| Body | Humanist sans, regular weight (e.g. Inter, system UI font) | All body copy, labels, buttons |
| Mono | Monospace (e.g. JetBrains Mono, IBM Plex Mono) | Diff readouts, pixel offsets, coordinates, hex values, file paths |

Wordmark set lowercase (`parity`), tight tracking, no letter-spacing tricks beyond a slightly negative tracking value (~-0.02em) at display sizes.

## 6. Voice notes for any UI copy touched during the rename

- Sentence case everywhere (buttons, headers, menu items) — no Title Case, no ALL CAPS
- Active voice, verb-first for actions ("Export report", not "Report export")
- Diff/audit results state facts plainly: "3 mismatches found," not "Uh oh, we found some issues!"

## 7. Out of scope for this pass

- No change to underlying feature names (Live, Automate, Edit, Audit workspaces keep their current names unless a separate request says otherwise)
- No change to data schemas, ticket integration formats, or file formats — this is a display-layer and packaging-level rename only
