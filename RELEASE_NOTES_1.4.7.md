# Parity 1.4.7

## Feedback and reports

- Add a Feedback button beside Settings in the title bar and a command-palette shortcut for bug reports, feature suggestions, and general feedback.
- Send reports through the signed-in Parity account to a private Supabase table. Reports include the selected workspace area, app version, and platform; page content, Notes, screenshots, and credentials are not attached automatically.
- Allow signed-in users to submit feedback before completing workspace setup. The service validates submissions and limits repeated reports.

## Public site

- Add dedicated privacy-policy and terms pages, link them from the Parity landing page, and link the privacy policy from Google sign-in settings.
- Explain on the landing page why Parity uses basic Google account information.

The release deploys the additive `parity_feedback` database migration and updated `parity-account-v2` Edge Function. Google branding verification still requires a domain the publisher owns; the Cloudflare Pages address alone cannot complete DNS ownership verification.
