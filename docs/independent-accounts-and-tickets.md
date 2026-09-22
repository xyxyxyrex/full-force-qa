# Independent accounts and ticket intake

Parity now authenticates accounts with Google through Supabase OAuth in Electron's main process. Monday is an optional ticket connector. Opsmosis and Manual support manual intake; there is no Opsmosis scraping or unconfirmed API implementation.

## User flow

1. Open Settings → Account, or choose Sign in from Notes or Tickets.
2. Choose **Continue with Google**. Parity opens the system browser, receives the OAuth result on a fixed loopback callback, and returns to the app with an encrypted session.
3. Choose **Restore my existing Monday workspace** or **Start a new workspace** before creating account-owned data. Restoration calls Monday to verify identity as well as verifying the Supabase session. A matching email does not link accounts. If necessary, connect Monday in Integrations and return to Account.
4. Add an Opsmosis or Manual ticket in Dashboard → Tickets. Paste details and use Suggest links, then review staging, admin, Figma and QA-sheet fields before saving.
5. Connect Monday and select boards and assignees under Settings → Integrations. Refresh changes source fields while retaining private QA progress and project edits.
6. Create a project, link an existing project, or create another page from the ticket. Capture and workspace resource pickers read the same saved ticket store.

Private QA statuses are To review, In review, Needs fixes and Verified. Source statuses remain separate. Manual tickets can be edited and archived. Their source identity is fixed after creation so existing project references remain valid. Archived tickets and disconnected-provider references remain stored.

## Ownership and persistence

- `parity_accounts.auth_user_id` uniquely associates a Supabase user with an existing owner. Restored owners remain `monday:<id>`; new owners are `parity:<uuid>`. Linking uses advisory locks and rejects duplicate claims and account merging.
- The v2 function calls `auth.getUser()` and resolves the owner on the server for every request. It never trusts a caller's owner key. Direct anonymous/authenticated table access and ownership RPC access remain revoked. The legacy endpoint is retained for older desktop clients.
- `parity-auth.bin` is encrypted with Electron safeStorage. Monday credential files are encrypted and scoped to the account, including a temporary scope during initial account setup. No external credentials enter the ticket database.
- Tickets use `tickets-<owner hash>.json`, atomic file replacement, pending flags and cloud revisions. Offline changes survive restart. Concurrent remote changes preserve the local version until the user chooses **Keep my version** or **Keep cloud version**. A lost acknowledgement for an identical save is recognized on retry.
- Account generations and explicit owner checks reject delayed private writes after an account change. Sign-out clears private views. Attachment URIs must match the active owner; attachment responses are not cached across sessions. Monday disconnection does not end the Parity session.
- A previously verified encrypted identity permits local project/ticket access during offline restoration; cloud requests still require a valid Supabase session. Expired sessions can be recovered by signing out and signing in again; owner-scoped pending ticket changes remain on disk.
- Restoration preserves project IDs, settings, folders, Notes, local attachment directories and pending project deletions. Projects queued for deletion are excluded from bootstrap results so they cannot be resurrected during retry.
- Local projects remain usable without signing in. Starting a new workspace does not silently claim an old private project store.

## Legacy ticket migration

The migration preserves `mondayTicketId`, `monday-*` project IDs, old caches and active selections. It adds `ticketRef`, preserves Monday aliases and writes legacy Monday references when linking Monday projects. Repeated refreshes retain stable Parity ticket IDs and QA progress.

Legacy global Monday caches do not carry reliable ownership metadata. They are retained but are not exposed to another account or blindly imported. After verifying the restored Monday identity, the adapter re-fetches authoritative records, imports active selections and upgrades project references. Migration is marked complete only after the new representation and references have been saved. Cached items outside the currently configured boards must be fetched through that verified connector before entering the new queue.

Folder-tab labels and navigation persistence remain intact.

## Deployment order

No hosted database, email provider, or production release is changed by the local verification scripts.

Release verification on 2026-09-22: project `hjrfvjvirdzdevzmcalp` has the additive account/ticket migration and active `parity-account-v2` endpoint. The migration dry run reports no pending changes, the public Auth settings report Google enabled, and the account endpoint rejects requests without a verified session. A successful real Google/Monday sign-in still requires an interactive user; local Electron tests use a contract server.

1. Back up the database and confirm the intended Supabase project. Deploy `20260921090000_independent_accounts_and_tickets.sql` after the existing account migration. Review the migration with `supabase db push --dry-run`, then apply it through the normal deployment process.
2. Deploy `parity-account-v2` (`supabase functions deploy parity-account-v2`). Retain `parity-account` and `monday-oauth`. The v2 gateway setting is `verify_jwt = false` because the handler performs verified-user lookup itself; it does not authorize requests from the public key alone.
3. Create a Google OAuth 2.0 client of type **Web application**. Add `https://hjrfvjvirdzdevzmcalp.supabase.co/auth/v1/callback` as an authorized redirect URI in Google Cloud. Enable the Google provider in Supabase Auth using that client ID and secret. Store the secret only in Google/Supabase configuration.
4. Add `http://127.0.0.1:51848/account/oauth/callback` to Supabase Auth's redirect URL allow list. Google returns to Supabase first; Supabase then returns the PKCE authorization code to this loopback address while Parity is running.
5. Validate successful login, denial, timeout, session restoration, sign-out and duplicate ownership claims in staging. The local contract-server test exercises the PKCE browser/callback exchange without contacting Google.
6. Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` for the desktop build independently of Monday. These are public values; never embed the service-role key. The main account client and anonymous review-sharing client remain separate instances.
7. Release independent sign-in/restoration, followed by shared ticket intake after staging acceptance. Keep legacy services available while older clients are supported. If rolling the desktop back, retain the additive data tables; do not remove account associations or ticket data.

Google OAuth setup follows [Supabase's Google provider guide](https://supabase.com/docs/guides/auth/social-login/auth-google). Parity uses PKCE, validates the Supabase authorization URL before opening it, accepts the callback only on `127.0.0.1`, and times out abandoned attempts after three minutes. The fixed loopback port must be available while signing in.

## Verification

- `npm test`: existing tests plus ticket repository, Monday adapter and v2 endpoint tests.
- `npm run test:accounts:database`: starts a temporary PostgreSQL cluster, applies the existing account schema plus the additive migration, checks restoration/data continuity, duplicate claims, forbidden merging, direct-role isolation and revision conflicts, then stops it. Set `PG_BIN` to the directory containing PostgreSQL binaries if it differs from the Windows PostgreSQL 16 default. It never connects to a hosted database.
- `npm run test:accounts:electron`: uses a temporary profile, real Electron safeStorage, Supabase client and IPC, Account and Ticket UI, and a local fake auth/account server. Checks Google PKCE callback handling, restoration, original attachments, manual Opsmosis intake, shared picker data, multiple page projects, account switching and encrypted session restoration. Expected rejection messages are printed for negative cases. Temporary artifacts and a screenshot are retained for inspection.
- `npm run test:automation:electron`: existing Electron automation regression flow.
- `npx tsc --noEmit -p tsconfig.node.json` and `npm run build`.
- Renderer diagnostic baseline: nine existing errors in EditBetaWorkspace, EditorWorkspace and grapesjs/init. These unrelated diagnostics are not changed by this work.

The local tests exercise the implementation and service contracts. Real Google and Monday OAuth/token refresh and production Supabase deployment require staging credentials and provider configuration.

## Opsmosis API contract checklist

Before adding automatic synchronization, obtain written confirmation and test access for:

- Authentication: OAuth/token mechanism, allowed desktop flows, scopes, token expiry/refresh/revocation and tenant identity.
- Identity: stable ticket/project IDs, uniqueness scope, moves between projects, merged tickets and deleted records.
- Fields: title, description format, project/group, source status, assignee IDs/names, created/updated timestamps and timezone.
- Resources: canonical ticket URLs, staging/admin/Figma/QA-sheet fields, attachments, rich-text links and permission rules.
- Fetching: project/assignee filters, cursor semantics, page size and deterministic ordering.
- Incremental sync: updated-since semantics, cursors, tombstones, webhooks and replay guarantees.
- Reliability: rate limits, retry-after headers, transient errors, timeout guidance and expected volumes.
- Test access: non-production endpoint, sample fixtures, representative project permissions and an owner for integration changes.

Implement the adapter against that confirmed contract, returning normalized `Ticket` values through `TicketProviderAdapter`. Reuse account ownership, queue storage, QA progress and resource pickers. External status/comment write-back, teams, CSV imports and a full project-management system remain outside this release.
