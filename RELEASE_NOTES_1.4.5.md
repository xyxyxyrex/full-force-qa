# Parity 1.4.5

## Workspace navigation

- Navigating to another URL inside an existing project offers to capture it as a new project in the current folder or another location. The original project's URL and saved capture stay intact while browsing.
- Recognize pages that are already projects and offer to open them instead of creating a duplicate.

## Edit inspector

- Hide whitespace-only text nodes in Layers by default, with a toggle to show them when needed. Meaningful text and SVG elements remain visible.
- Label doctypes and other non-element DOM nodes accurately, and avoid empty expand arrows when all loaded children are hidden whitespace.

## Audit media gallery

- Browse captured images, SVGs, icons, videos, and audio from a searchable, resizable gallery below Audit Downloads.
- Preview images, play supported audio and video, inspect capture locations, locate elements on the Audit canvas, copy source details, download individual files, and export all media.
- Preserve resource authentication through Electron's session for previews and downloads, and report unavailable capture-only resources clearly.

No Supabase schema migration is required for this release.
