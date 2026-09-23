# Parity 1.4.6

## Dashboard and Audit

- Restore right-click and three-dot context menus for Dashboard projects and folders.
- Bring Audit’s left inspector in line with Edit: browse DOM layers, inspect and edit styles, review computed values and layout, and navigate annotations.
- Make Escape clear the active Audit selection.
- Improve Audit spellchecking by excluding hidden text, avoiding duplicate findings, and validating suggestions against the dictionary rather than hardcoded words.

## Captured assets

- Repair Audit media previews and downloads for HTTP assets referenced by HTTPS pages. Parity tries the same-host HTTPS URL first and omits the HTTPS referrer if it must fetch the original HTTP resource.
- Apply the same safe referrer handling to capture-time asset requests, resource-size checks, and link probes. Original captured URLs remain in audit inventories.

No Supabase schema migration is required for this release.
