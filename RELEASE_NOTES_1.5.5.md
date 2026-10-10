# Parity v1.5.5

Parity's assistant now understands the application and can search your workspace, help find captures by date, and preview project/folder changes before you apply them.

- Workspace search and details cover projects, folders, captures, findings, notes and tickets, with account-scoped cloud/cache results and clearer date meanings.
- Reviewed project/folder creation, renaming, moving and trash/restore reuse existing persistence. Creating projects saves links; pages are captured when opened.
- Choose a provider/model per conversation, shared between docked and detached chat, with safe handoffs during active work.
- Cleaner Chat/Findings tabs, compact breakpoint indicators and tooltips, a minimal composer, and thinking placeholders.
- Attach, paste or drop images into chat; click thumbnails to view originals in a lightbox.
- Replies type out quickly; hover or focus to copy a complete answer. Reopened histories and reduced-motion mode display immediately.
- `/usage` shows reported chat token totals. `/quota [agent ID] [--refresh]` shows provider allowance/reset times where available, with loading, cancellation, retry and honest unavailable states.
- Fixed Gemini tool loops by preserving thought signatures through streaming and retries.
- Strengthened account isolation for workspace actions, chat histories, result artifacts, evidence and late events.

CI and release gates include type checks, unit tests and Electron regressions. The Windows installer, blockmap and auto-update manifest publish before the landing page and ephemeral viewer deploy to Cloudflare Pages.

Validated locally: 725 unit tests passed, 28 platform-dependent tests skipped; QA UI, flow and detached-window regressions passed; main/renderer type checks and production build passed. Codex quota discovery was also verified against an installed CLI without starting an inference turn.

Claude headless and Gemini API quota data can be unavailable; Parity provides observed readings or provider guidance rather than guessing balances. Antigravity quota parsing depends on the CLI's supported text-report format.
