# Parity 1.4.2

## Automation

- Rebuilt visual comparison around native-resolution Pixelmatch in a cancellable background worker. Images are not resized, warped, or locally shifted to conceal differences.
- Added Design, Live, Diff, and Slider inspection views with evidence details, filtering, ignore/restore, and annotation creation.
- Replaced confidence percentages with explicit result states and evidence strength. Repeated or uncertain text matches remain ambiguous.
- Removed the 240-text-node comparison limit and retained actual page dimensions, including content outside the compared overlap.
- Improved capture readiness, native viewport handling, cancellation, and explicit failure reporting.
- Fixed Figma exports being rejected for a one-pixel raster rounding difference. Original image pixels and dimension differences are preserved.

## Distribution

- Windows installer, auto-update metadata, and PowerShell installer updated to 1.4.2.
- Release builds now run regression tests and the Electron/ASAR Automation smoke test before publication.
- The landing page waits for its matching Windows installer to be published before deploying.

This is the Automation foundation phase. Image identity validation and advanced rendering normalization are not claimed as completed capabilities.
