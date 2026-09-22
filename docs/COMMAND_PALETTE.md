# Search and commands

Open the centered palette with **Ctrl+Shift+F** (also Cmd+Shift+F), or the activity-bar search button. The shortcut works in the application, captured iframes and the application's Chromium previews. It is reserved in shortcut settings.

- Type words to search; all words must match. Use quotes for a phrase. Matching is case-insensitive and accent-insensitive.
- Type `>` to restrict results to commands, or choose a category.
- Arrow keys select a result, Enter runs it, and Escape closes the palette. Focus returns to the previously focused control. The modal traps focus and blocks workspace shortcuts.
- Results are fetched in bounded batches. **Show more matches** expands the results. Categories are applied before limiting results, so a large number of text matches does not hide matching files.
- Disabled actions include their availability reason. Operations continue to use existing handlers, dialogs and confirmations.

## Coverage

Page search recursively traverses the active preview's DOM and open author shadow roots. It includes author text (including hidden text), element attributes, links, asset URLs and inline CSS/script source. It skips Parity instrumentation, templates, password/secret/token attributes, input values and inline event handlers. It searches the actual current document; it does not crawl linked pages. Selecting a page result scrolls to and highlights the original node; Edit also selects it in the inspector when it is in the main document. Removed nodes and results from an old document/index are rejected.

**Files** includes referenced image/script/stylesheet/media URLs, inline source and the resources saved in Audit capture metadata. It does not read the computer's filesystem, fetch external file bodies or inspect embedded iframe contents. These boundaries are shown under **Search coverage**.

Workspace search includes saved non-trashed projects and their resource URLs, recursively named project folders, tickets (including archived tickets), saved annotations, open tabs, and private Notes/attachment names already loaded through the signed-in account. Note bodies and attachment contents are never fetched just for search. Notes are cached only in memory, updated by the Notes editor and cleared on account change. Ticket results open the matching queue filter, note results open the note, folder results open that directory. Saved annotation results open their project; active annotation results select the annotation.

The command registry exposes all configured workspace shortcut actions plus app navigation, settings sections, themes, preview toolbar actions, snapshots, Figma comparison and Audit exports. Current-view buttons, toggles and named form fields are also discovered from their existing accessible labels, providing shortcuts for contextual inspector, ticket, Notes, Audit and Automate controls. Workspace-specific controls become available when that workspace/panel is mounted; commands that need a captured project show that prerequisite on the Dashboard. This is not a remote script execution interface.

## Performance and lifecycle

- Queries debounce for 150 ms. Superseded results never replace newer results.
- Page indexing yields every 250 nodes; matching yields every 500 records. Workspace matching yields every 400 records and caches normalized strings.
- One index is reused per open palette/document, and MutationObserver marks it dirty after DOM changes. Traversal is iterative, with no tree-depth cutoff.
- At most 80 results per source are initially returned. More results load on demand, up to 10,000 per source in one palette session; the full match count remains visible.
- Closing the palette cancels pending result publication, disconnects observers and releases page node references. Account changes clear results and private caches. Tab/workspace changes close the palette.
- Sources fail independently. Provider timeouts and coverage limitations appear in the palette instead of silently appearing as empty search results.

## Extending commands

Use `usePaletteProvider({ id, label, commands, search, release })` from `src/renderer/src/palette/registry.ts`. The hook keeps handlers current and unregisters on unmount. Commands need stable IDs, human-readable titles, a group, an optional availability reason and their existing action handler. Search providers must honor `AbortSignal` and the requested category/result limit. Return complete counts separately from limited result arrays. Do not persist search queries, captured node references, Notes or credentials in a search index on disk.

## Validation

`npm run test:palette:electron` uses an isolated profile and deterministic local documents. It tests command execution, modal focus, the shortcut from an actual embedded Chromium guest, stale-query rejection, account-change clearing, hidden/shadow text, resource URL search, a 3,000-match page, DOM mutation, detached-node rejection and index cleanup. Unit tests cover ranking, escaping, quoted terms, normalized text, limits, cancellation, nested folders and owner isolation. Restart the Electron development process after installing the main/preload shortcut changes.
