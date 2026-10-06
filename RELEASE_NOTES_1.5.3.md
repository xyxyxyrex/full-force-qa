# Parity v1.5.3

## Protected staging sites

- Show a themed HTTP username/password sign-in dialog during Chromium capture, previews, and Firefox/WebKit comparison.
- Keep the dialog usable inside modal WordPress login windows and resume capture after sign-in.
- Reuse matching credentials in the current app session without saving them to projects or syncing them to Supabase.
- Add incorrect-password retries, keyboard cancellation, parallel-viewport prompt sharing, and cleanup when a page closes or the account changes.
- Pause capture timeouts during sign-in and stop cancelled captures with a clear message.

## QA agent

- Add a separate browser for testing links, menus, buttons, forms, and page errors. Reviews can run without a design reference.
- Keep functional testing read-only by default; submitting forms or sending API changes requires enabling the existing setting.
- Add six text-based checks for element styles, contrast, layout, typography consistency, copy, and SEO.
- Add OpenRouter free-model discovery, Gemini free-tier setup, lighter review runs, and an optional API key for compatible local/server endpoints.
- Retry temporary rate limits and report exhausted quotas clearly, preserving partial batch findings.

## Review history and hand-over

- Browse past reviews and evidence, keep selected runs, copy approved rows again, and reopen saved chats.
- Leave individual findings out of a hand-over, show suggestions distinctly, and leave priority/severity columns blank.
- Open uploaded evidence in the Parity browser viewer.

## Release verification

- Include staging HTTP authentication, QA browser, page-check, and evidence-viewer Electron regressions in Windows CI and the desktop release gate.
- Publish the Windows installer, blockmap, updater metadata, and PowerShell installer through GitHub Releases; refresh Cloudflare Pages after installer publication.
