# Production deployment and desktop updates

This repository deploys three connected surfaces:

| Surface | Workflow | Trigger | Destination |
| --- | --- | --- | --- |
| Desktop and viewer CI | `ci.yml` | Pull requests, `main`, or manual | GitHub Actions only |
| Parity viewer | `deploy-cloudflare.yml` | Relevant changes on `main`, or manual | Cloudflare Pages Direct Upload project `parity` |
| Database and Edge Functions | `deploy-supabase.yml` | Changes under `supabase/` on `main`, or manual | Linked Supabase production project |
| Windows desktop release | `release-desktop.yml` | A matching `v*.*.*` tag, or manual | GitHub Release with NSIS update files |

All deployment jobs reference a GitHub environment named `production`. Configure that environment and its secrets before pushing these workflows.

## 1. Create and protect the GitHub environment

In `xyxyxyrex/full-force-qa`:

1. Open **Settings → Environments**.
2. Select **New environment**.
3. Enter `production` exactly, then select **Configure environment**.
4. Under **Deployment branches and tags**, allow the `main` branch and release tags matching `v*.*.*`.
5. Recommended: add a required reviewer and prevent self-review. A job cannot read environment secrets until its protection rules pass.
6. Under **Environment secrets**, add the credentials listed below. Do not put credential values in workflow YAML, `.env.example`, issues, logs, or commits.

Official references: [GitHub deployment environments](https://docs.github.com/en/actions/concepts/workflows-and-actions/deployment-environments), [managing environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments), and [environment secrets](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets).

### Required secrets

| GitHub environment secret | Exact value to store | Used by | Sensitivity |
| --- | --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | Custom Cloudflare token with `Account → Cloudflare Pages → Edit` for the account containing `parity` | Cloudflare deployment | Secret |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID containing the Pages project | Cloudflare deployment | Identifier |
| `VITE_SUPABASE_URL` | Project URL, normally `https://<project-ref>.supabase.co` | Cloudflare viewer and desktop release | Public configuration |
| `VITE_SUPABASE_ANON_KEY` | Prefer the current `sb_publishable_…` key; the legacy anon JWT also works | Cloudflare viewer and desktop release | Public client key |
| `VITE_EPHEMERAL_VIEWER_URL` | `https://parity-gfx.pages.dev` | Desktop release and workflow validation | Public configuration |
| `SUPABASE_ACCESS_TOKEN` | Supabase personal access token beginning with `sbp_` | Supabase CLI deployment | Secret |
| `SUPABASE_DB_PASSWORD` | Password for the production project's `postgres` role | Supabase migrations | Secret |
| `SUPABASE_PROJECT_ID` | Project reference from the Supabase dashboard URL | Supabase deployment | Identifier |
| `MONDAY_CLIENT_ID` | Client ID from the Parity app in Monday Developer Center | Supabase `monday-oauth` function | Public identifier |
| `MONDAY_CLIENT_SECRET` | Client secret from the same Monday app | Supabase `monday-oauth` and private `parity-account` session signing | Secret |

The name `VITE_SUPABASE_ANON_KEY` is retained for compatibility with the application, but its value should preferably be Supabase's newer publishable key. Never place an `sb_secret_…` or legacy `service_role` key in either `VITE_` value: Vite embeds these values into public viewer and desktop artifacts. Supabase requires Row Level Security to protect data accessed with publishable/anon credentials.

### Optional Windows signing secrets

| GitHub environment secret | Exact value to store |
| --- | --- |
| `WINDOWS_CERTIFICATE` | Base64-encoded exportable `.pfx`/`.p12` Authenticode certificate, or an HTTPS URL accepted by electron-builder |
| `WINDOWS_CERTIFICATE_PASSWORD` | Password used when exporting the certificate |

Without these optional signing secrets, electron-builder can produce an unsigned installer and Windows may show an unknown-publisher warning. The current workflow maps them to `CSC_LINK` and `CSC_KEY_PASSWORD`. Hardware-token EV certificates do not fit this workflow without a separate signing service or custom signing configuration.

GitHub automatically creates `GITHUB_TOKEN` for every job; do not create a secret with that name. The workflows explicitly grant it `deployments: write` for Cloudflare deployment records and `contents: write` for desktop releases. See [GitHub's `GITHUB_TOKEN` documentation](https://docs.github.com/en/actions/concepts/security/github_token).

### Monday OAuth application

Create or update the Parity integration in Monday's Developer Center before deploying the `monday-oauth` Edge Function:

1. Enable Monday's **New OAuth Flow** for the app version and promote that version after testing.
2. Add the exact redirect URL `http://localhost:51847/oauth/callback`. The desktop application binds this loopback callback only while a login is in progress.
3. Enable `me:read`, `boards:read`, and `users:read`. Add broader scopes only when a feature actually requires them.
4. Copy the app's client ID and secret into the `production` GitHub environment using the names in the table above.
5. Push the `supabase/` or Supabase workflow changes. The workflow sets the Edge Function secrets before deploying the function; the client secret is never bundled into Electron.

The OAuth function exchanges and refreshes tokens at Monday's server-side OAuth 2.1 endpoint. Electron stores the returned access/refresh pair using the operating-system credential service. A personal API token can still be entered from the Dashboard as an advanced fallback; it receives the same encrypted local storage treatment.

The deployed exchange defaults to compatibility mode. It attempts Monday OAuth 2.1 first and retries the legacy token endpoint only when Monday reports that the authorization grant is absent from the new token service. This keeps desktop login working while the **New OAuth Flow** toggle is being promoted between draft and live Monday app versions. Once every active app version uses OAuth 2.1, the optional Edge Function secret `MONDAY_OAUTH_FLOW=new` can disable the legacy compatibility path.

### Monday-backed Parity accounts

Monday is the identity authority for Parity account data; it is not configured as a native Supabase Auth provider. After Monday authorization, Electron sends the access token only to the `parity-account` Edge Function. That function verifies the token with Monday's `me` query, issues a short-lived Parity data session, and performs owner-scoped database operations with the service role. Monday tokens, the Supabase service-role key, and the Parity data session are never exposed to the renderer.

The `parity_accounts`, `parity_user_state`, `parity_projects`, and `parity_notes` tables have RLS enabled and grant no direct access to `anon` or `authenticated`. Every row is keyed by the verified Monday user ID. Settings, folders, project metadata, and rich-text note documents synchronize through the Edge Function. Project capture thumbnails and note attachment bytes remain in Electron's local `userData` directory; only attachment metadata and local URIs are stored in Supabase.

Existing users may need to reconnect Monday once after upgrading if their encrypted credential predates the stored Supabase public configuration. Switching Monday users creates a separate local project store and loads only that user's Supabase records.

The app pins Monday GraphQL calls to API version `2026-07`. Board and user selectors include only resources visible to the authorizing Monday user. Sync uses `items_page` cursor pagination and therefore supports boards larger than one page, while still remaining subject to the account's Monday API complexity, daily, minute, and concurrency limits.

Official references: [Monday OAuth 2.1 migration](https://developer.monday.com/apps/docs/migrating-to-the-new-oauth-flow), [Monday `items_page`](https://developer.monday.com/api-reference/reference/items-page), [Monday API rate limits](https://developer.monday.com/api-reference/docs/rate-limits), and [Monday API versioning](https://developer.monday.com/api-reference/docs/api-versioning).

## 2. Create the Cloudflare credentials

### Deployment model: Wrangler Direct Upload

The `parity` Pages project is created and deployed with Wrangler. It is a **Direct Upload** project, not a Pages project connected to a GitHub repository.

The deployment flow is therefore:

```text
GitHub Actions
  → npm run build:viewer
  → prebuilt dist-viewer directory
  → wrangler pages deploy
  → parity Direct Upload project
```

Important consequences:

- Do **not** select **Connect to Git** or install the Cloudflare Workers & Pages GitHub App for this project.
- Do **not** configure a build command, repository, or production-branch automation inside the Cloudflare Pages dashboard. GitHub Actions performs the build; Wrangler only uploads the resulting `dist-viewer` directory.
- The GitHub workflow is an external CI client of Cloudflare. Its API token replaces the interactive `wrangler login` session used for local deployments.
- Deploy production revisions to the project name `parity-gfx`, which owns `https://parity-gfx.pages.dev`. Keep the former `parity` project at `https://parity-rz8.pages.dev` online so previously issued expiring links continue to resolve.
- Cloudflare does not support changing a `*.pages.dev` subdomain in place. The former `qa-snapshots` Direct Upload project remains online temporarily so previously issued expiring links continue to resolve; do not delete it until the longest issued link has expired.
- Cloudflare states that a Direct Upload project cannot later be converted to Git integration. A separate Pages project would be required if that deployment model were ever desired.

The repository already contains the required Pages configuration in `wrangler.jsonc`:

```jsonc
{
  "name": "parity",
  "pages_build_output_dir": "./dist-viewer"
}
```

The production workflow ultimately runs the equivalent of:

```powershell
npx wrangler pages deploy dist-viewer --project-name=parity-gfx --branch=main
```

See Cloudflare's [Direct Upload guide](https://developers.cloudflare.com/pages/get-started/direct-upload/) and [Direct Upload with CI guide](https://developers.cloudflare.com/pages/how-to/use-direct-upload-with-continuous-integration/).

### API token

1. Sign in to the [Cloudflare dashboard](https://dash.cloudflare.com/).
2. Open **My Profile → API Tokens**, or use the account's API Tokens page.
3. Select **Create Token**.
4. Under **Custom Token**, select **Get started**.
5. Give it a recognizable name such as `full-force-qa-pages-production`.
6. Add permission **Account → Cloudflare Pages → Edit**.
7. Restrict **Account Resources** to the account containing the `parity` Pages project.
8. Review and create the token, then copy it immediately into the GitHub environment secret `CLOUDFLARE_API_TOKEN`.

Do not use the Global API Key. The narrowly scoped custom token is sufficient for Wrangler Pages Direct Upload from GitHub Actions.

### Account ID and Pages project

The Account ID identifies the Cloudflare account that owns the Wrangler-created `parity` project. It is not created by, and does not require, a Cloudflare/GitHub repository connection.

To retrieve and verify it from the dashboard:

1. Open **Workers & Pages** in the correct Cloudflare account.
2. Confirm the production Pages project is named `parity-gfx` exactly.
3. Copy **Account ID** from the Workers & Pages **Account details** area, or from the account home menu.
4. Store it as `CLOUDFLARE_ACCOUNT_ID` in the GitHub `production` environment.

To verify the same account and project with the local Wrangler authentication that performed the original deployment:

```powershell
npx wrangler whoami
npx wrangler pages project list
npx wrangler pages deployment list --project-name parity-gfx --environment production
```

`wrangler whoami` displays the authenticated account membership and Account ID. `pages project list` must include `parity`. If multiple Cloudflare accounts are available, use the Account ID belonging to the row that contains that project.

Do not use the Zone ID; Pages deployment requires the Account ID. See [Find account and zone IDs](https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/).

## 3. Create the Supabase credentials

Use the same production project for all five Supabase-related values.

### Project URL and publishable key

1. Open the project in the [Supabase dashboard](https://supabase.com/dashboard).
2. Select **Connect**, or open **Settings → API Keys**.
3. Copy the project URL into `VITE_SUPABASE_URL`.
4. Copy a **Publishable key** (`sb_publishable_…`) into `VITE_SUPABASE_ANON_KEY`.

The legacy anon key is still supported, but Supabase recommends publishable keys for web, mobile, desktop, CI, and other public clients. Never use a secret/service-role key here. See [Supabase API keys](https://supabase.com/docs/guides/getting-started/api-keys).

### Personal access token

1. Open [Supabase Account → Access Tokens](https://supabase.com/dashboard/account/tokens).
2. Generate a token specifically for this deployment workflow, for example `full-force-qa-github-actions`.
3. The token's account must have access to the production project.
4. Copy it into `SUPABASE_ACCESS_TOKEN`.

The CLI consumes this token from the environment and does not need an interactive `supabase login` in CI. See the [Supabase CLI login reference](https://supabase.com/docs/reference/cli/getting-started).

### Project reference

Copy the value after `/project/` in the dashboard URL:

```text
https://supabase.com/dashboard/project/<project-ref>
```

Store only `<project-ref>` in `SUPABASE_PROJECT_ID`. This is the value passed to `supabase link --project-ref` and Edge Function deployment.

### Database password

Use the password for the production project's `postgres` database role. If it is unavailable:

1. Open **Database → Settings** in the Supabase dashboard.
2. Reset the database password.
3. Store the new value in `SUPABASE_DB_PASSWORD`.
4. Update any other external services that use the old database password.

The GitHub workflow passes the password as an environment variable, so do not URL-encode it. Password resets can take a few minutes to propagate. See [resetting the database password](https://supabase.com/docs/guides/troubleshooting/how-do-i-reset-my-supabase-database-password-oTs5sB) and [Supabase's CI environment guide](https://supabase.com/docs/guides/deployment/managing-environments).

## 4. Add secrets safely

### GitHub web interface

For every name above, open:

**Repository Settings → Environments → production → Environment secrets → Add secret**

GitHub will not show a secret value again after it is saved. Environment-level values take precedence over repository-level values with the same name.

### GitHub CLI

After creating `production`, these commands prompt securely for each value and do not print it:

```powershell
gh auth login
gh secret set CLOUDFLARE_API_TOKEN --env production --repo xyxyxyrex/full-force-qa
gh secret set CLOUDFLARE_ACCOUNT_ID --env production --repo xyxyxyrex/full-force-qa
gh secret set VITE_SUPABASE_URL --env production --repo xyxyxyrex/full-force-qa
gh secret set VITE_SUPABASE_ANON_KEY --env production --repo xyxyxyrex/full-force-qa
gh secret set VITE_EPHEMERAL_VIEWER_URL --env production --repo xyxyxyrex/full-force-qa
gh secret set SUPABASE_ACCESS_TOKEN --env production --repo xyxyxyrex/full-force-qa
gh secret set SUPABASE_DB_PASSWORD --env production --repo xyxyxyrex/full-force-qa
gh secret set SUPABASE_PROJECT_ID --env production --repo xyxyxyrex/full-force-qa
```

Optional signing values:

```powershell
gh secret set WINDOWS_CERTIFICATE --env production --repo xyxyxyrex/full-force-qa
gh secret set WINDOWS_CERTIFICATE_PASSWORD --env production --repo xyxyxyrex/full-force-qa
```

List configured names without revealing their values:

```powershell
gh secret list --env production --repo xyxyxyrex/full-force-qa
```

GitHub environment secrets are limited to 48 KB. electron-builder also documents a Windows environment-variable limit of 8192 characters for base64 certificates; if the certificate is too long, re-export the `.pfx` without the full intermediate chain. See [GitHub secret limits](https://docs.github.com/en/actions/reference/security/secrets) and [electron-builder code signing](https://www.electron.build/docs/features/code-signing/).

## 5. Validate and perform the first deployment

Run the workflows from the repository's **Actions** tab in this order:

1. **CI** — confirm desktop, viewer, and clean-database migration checks pass.
2. **Deploy Supabase** with `dry_run: true` — inspect the pending migration plan without applying it.
3. **Deploy Supabase** with `dry_run: false` — apply migrations and deploy any Edge Functions.
4. **Deploy Cloudflare Pages** — build the viewer with the production Supabase client values and deploy `dist-viewer`.
5. Open `https://parity-gfx.pages.dev` and test a newly generated master link and item link, including status changes, comments, rich-text images, and expiry behavior.

The workflows stop early with a named `Missing …` error if required secrets are absent. Supabase deployments are serialized so two schema pushes cannot run concurrently; Cloudflare deployments cancel an older pending run when a newer viewer revision is ready.

## 6. Publish a desktop update

The desktop release now receives the same `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` values as the viewer. This is required because Vite client configuration is embedded at build time; a local untracked `.env` file is not present on a fresh GitHub runner.

1. Increment `version` in `package.json` and `package-lock.json`.
2. Commit and push the release changes.
3. Create and push a tag that exactly matches the package version:

```powershell
git tag v1.0.1
git push origin main
git push origin v1.0.1
```

The release workflow validates the tag, builds the Windows NSIS installer, and publishes the installer, blockmap, `latest.yml`, and version-stamped `install.ps1` to GitHub Releases. The Cloudflare Pages build serves the same bootstrapper at `https://parity-gfx.pages.dev/install.ps1`; it resolves the newest published release at runtime and uses the package version as an API-failure fallback. Keep the release published rather than draft; desktop clients and the bootstrapper cannot discover draft releases. The current public repository allows clients to fetch releases without embedding a GitHub credential. See [electron-builder auto update](https://www.electron.build/docs/features/auto-update/).

## 7. Rotation and recovery

- **Cloudflare token:** create a replacement custom token, update the GitHub secret, run the Pages workflow, then revoke the old token.
- **Supabase access token:** create a replacement PAT, update the GitHub secret, run a Supabase dry run, then revoke the old PAT.
- **Database password:** reset it in Supabase, update `SUPABASE_DB_PASSWORD`, then run the dry-run workflow. Update other database clients as well.
- **Publishable key:** create/copy the replacement key, update `VITE_SUPABASE_ANON_KEY`, then redeploy both Cloudflare Pages and the desktop app. Do not disable the old key until deployed clients have migrated.
- **Signing certificate:** replace both signing secrets before expiry and confirm the installer reports the intended publisher.

If any credential is exposed in logs, chat, source control, or an issue, rotate it immediately; deleting the text from Git history is not sufficient by itself.

## Troubleshooting checklist

- `HTTP 404` while listing environment secrets: create the `production` environment first and confirm you have repository admin access.
- Cloudflare authentication failure: confirm the token uses **Account → Cloudflare Pages → Edit**, the resource includes the correct account, and `CLOUDFLARE_ACCOUNT_ID` is not a Zone ID.
- Cloudflare project-not-found error: run `npx wrangler pages project list` with the original/local Wrangler account, confirm the project name is exactly `parity`, then make sure GitHub uses that account's ID. Do not resolve this by connecting a separate Git-integrated project.
- Supabase link failure: confirm the PAT's user can access the project, `SUPABASE_PROJECT_ID` is only the project reference, and the database password is current.
- Viewer loads but data does not: confirm `VITE_SUPABASE_URL` and the publishable key belong to the same project, then review Supabase RLS and Storage policies.
- Desktop integration is unconfigured: confirm both `VITE_` secrets exist in `production` and rebuild the desktop release; changing a secret cannot alter an already published installer.
- Update is not detected: confirm the release is published, the version is newer, and the `.exe`, `.blockmap`, and `latest.yml` came from the same release build.
- Installer shows unknown publisher: configure both Windows signing secrets and publish a newly signed version.
