# Parity v1.5.1

## QA agent

- Add an approval-gated QA agent that compares live pages with per-page Desktop, Tablet, and Mobile design references and drafts tracker-ready findings.
- Add a docked QA chat with Codex, Claude Code, Antigravity CLI, API-key, and local-model backends.
- Add the local `parity` CLI and authenticated MCP/JSON bridge for capture, context, section evidence, drafts, and final approval.
- Add no-design reviews and sequential batch reviews from Multi-capture, with findings grouped by page.
- Add detailed finding cards, enlargeable evidence, tracker-format validation, token limits, and safe clipboard output.

## Storage and release coverage

- Add private, expiring Supabase evidence storage through the `qa-evidence` edge function and `20261004120000_create_qa_evidence.sql` migration.
- Include the Parity CLI in packaged desktop resources.
- Run QA capture, end-to-end flow, and UI Electron regressions in Windows CI and the desktop release gate.
