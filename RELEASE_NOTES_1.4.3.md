# Parity 1.4.3

## Accounts and tickets

- Sign in to Parity with Google independently of Monday. Restore an existing Monday workspace with verified ownership, preserving Notes, projects and attachment paths.
- Use one private ticket queue for Monday, manual Opsmosis and generic tickets, with project links, QA progress, offline changes and explicit sync conflict resolution.
- Disconnecting Monday leaves the Parity account signed in. Automatic Opsmosis synchronization remains deferred pending its API contract.

## Edit inspector

- Inspect the actual Chromium DOM, attributes and matched CSS through Layers and the Rules, Computed and Layout tabs.
- Edit declarations, selectors, attributes and layout, force pseudo-states and use temporary undo/redo history in the active preview. Edits reset on reload.
- Preserve expanded DOM branches during section resizing and visual edits, and fix selection of elements with IDs.
- Shorten the viewport toolbar timeout to 1.5 seconds and show its locked state.

## Audit downloads

- Export images, text, links, SEO/data, assets or a complete bundle from the saved capture into a chosen folder.
- Include inventories, capture coverage, progress, cancellation and failure summaries. Fix the download controls remaining busy after link exports.

## Navigation and search

- Open the command palette with Ctrl+Shift+F to search commands, workspace records and the active page. Use `>` to focus on commands.
- Search is debounced and indexed, with grouped results, keyboard navigation and safeguards against stale selections. External file contents and embedded iframe contents are outside this release's search scope.
- Show folder names in workspace tabs and preserve folder navigation when switching tabs.

## Distribution

- Windows installer, auto-update metadata, PowerShell installer and Cloudflare download page updated to 1.4.3.
- Retain legacy Supabase account services alongside the additive independent-account and ticket schema and v2 endpoint.

Windows installers are unsigned, as in the previous release. The renderer retains its existing nine TypeScript diagnostics; the production bundle and release regression checks are validated separately.
