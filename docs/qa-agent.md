# QA agent

An AI agent that does the first pass of QA on a staging page. It checks how the page **looks** (against the Figma exports when you have them, on its own when you do not), how it **works** (links, menus, buttons, forms, console and network errors, in a browser of its own) and the **SEO and accessibility basics**, adds a few **suggestions** of its own, drafts it all as rows for the master tracker, and hands them to you. **You approve the rows in Parity before anything is copied or uploaded.** A design is never required, and the agent does not ask for one.

## The workflow

1. **Store the designs.** Open the project, open the Figma overlay panel and drop the Figma PNGs on the Desktop, Tablet and Mobile slots (or just drop several at once: each goes to its detected breakpoint). Parity works out the export scale (1x, 2x, 3x) from the file name or its width and shows it, so you can correct it.
   **Designs are kept per page.** The slots show the page they belong to ("For page /alopecia-page") and follow the page that is open: change the URL inside the project and the slots switch to that page's PNGs (empty if it has none yet), so a design is never compared with the wrong page. The chat header shows the same thing before you run anything: the page, and the PNG loaded for each breakpoint, with a warning for any that is missing. **The overlay follows the viewport.** With Desktop, Tablet and Mobile PNGs stored for the page, the Figma overlay shows the one for the breakpoint the viewport is at (under 600px wide is Mobile, 600–1199px Tablet, 1200px and up Desktop): switch the viewport and the overlay switches with it. A breakpoint with no PNG shows an empty overlay and a note, never an image of another size. Pasting or dropping a PNG moves the viewport to the breakpoint it belongs to, so a mobile PNG pasted while viewing Desktop switches to Mobile and shows. A review states the page and the designs it is using as its first message. Designs saved before this change move to the page they were added for the first time that page is opened.
2. **Tracker format.** The standard tracker is built in: Page Link, Section, Screenshot, Remarks, Priority (QA/PM), Display, Status, Approval Screenshot(QA), Reason for Rejection, Screenshot and Remarks (Dev), Remarks (PM), Remarks (CRSM). The agent fills Page Link, Section and Remarks, Parity fills Screenshot with the evidence link, and the Priority, Dev, PM, CRSM and approval columns stay empty. **Priority is never filled**: the agent does not judge it, and Parity drops anything written in a priority, severity or impact column, in any tracker. The team sets priority. Display is a dropdown (Desktop, Mobile, Tablet, Mobile & Tablet, Desktop and Mobile, Desktop and Tablet) and the agent picks where the issue appears; Parity rejects anything outside the list. Status is left empty because developers and the approval step set it, except "ENHANCEMENT (QA)" for suggestions. To use a different tracker, paste its header row and two or three example rows in Settings → AI Agents → Tracker format.
3. **Pick an agent** (Settings → AI Agents) and open the QA chat (`Ctrl+Shift+Q` or the chat button in the top bar). The chat opens on the right and takes the place of the inspector until you close it.
4. **Talk to it or run a review.** Type a question or a request ("how big is the hero heading on mobile?", "recheck the footer", "QA this page", "test the contact form", "any broken links?") and the agent answers using the live page, your designs if there are any, and its own browser. It remembers the conversation until you press *New chat*. `/review` runs the full review: the look on every breakpoint that has a design (every breakpoint when there is none), then the functional test; `/review desktop mobile --agent codex` narrows it and `/review --visual-only` skips the test. `/stop` (or Esc) stops the agent, `/agents` lists the agents, `/help` lists the commands.
   The header shows token use: the total for this chat with input and output split, what the current message has used so far, and (on hover) the size of the conversation the agent is holding. Every request re-sends the conversation, so input tokens add up faster than the text on screen. If you set a token limit in Settings → AI Agents it applies to each message and each review. Some agent programs do not report usage; the meter then shows a dash.
5. **Approve.** An approval card shows each finding with its evidence picture. Press **Leave out** on any finding that should not go in the sheet: it is neither copied nor uploaded (*Put back* undoes it). *Approve & copy* puts the rest on your clipboard and uploads their pictures, if enabled; *Reject* sends your note back to the agent.
6. **Paste into the tracker.**

## Reviewing with no Figma design

A page does not need a design. With none stored for the page, `/review` has the agent judge the live page **on its own**: broken or stretched images, typos and placeholder text, overflow, overlapping or clipped content, uneven gaps and unequal cards, headings or buttons that are inconsistent with each other, text too small or low-contrast, and content that breaks at a breakpoint. It reports only what is clearly wrong and never invents a design to compare with. Findings are written in the same short wording (`/review --no-design` does this even when designs are stored).

**Many pages at once (Multi-capture).** In the dashboard's Multi-capture dialog, paste the links and press **Save & review with QA agent** (or **Review with QA agent** when they are already saved). Tick the screen sizes to cover (Desktop and Mobile by default; Tablet is optional because every size is a full review of the page). Parity:

1. saves any new links as projects, as before;
2. opens the QA chat and reviews the pages one after another, each on every ticked size, with no design (up to 50 pages at once);
3. puts every finding in one approval card, grouped by page, with each finding's picture. One *Approve & copy* puts all the rows on the clipboard, with each row's Page Link filled in.

Display is set by Parity from the size a finding was seen at, never left to the model. The same finding on two sizes becomes one row with the matching combined value (for example "Desktop and Mobile"); a finding on all three sizes stays as three rows, because the sheet has no value for it. The page list comes from you, so the agent can only ever capture the pages you pasted (WordPress admin and login pages are refused). **Cost.** Every page is reviewed on every ticked size, and each review is a long conversation with many pictures. Measured with Antigravity CLI on a small three-section test page, one desktop review used about 500,000 tokens (roughly three minutes); real pages with more sections use more, and every request carries the agent app's own fixed overhead (about 12,000 tokens). A list of 20 pages on two sizes is 40 such reviews, so use a token limit in Settings → AI Agents (it covers the whole batch; if it is reached, what was found so far is handed over for approval) and start with a few pages. An API key is billed per token instead of drawing on a plan.

## Testing how the page works

The agent has **its own browser**: a hidden window it can click, type into, scroll and read, signed in with your WordPress login for the site under review. Reviews use it after the look has been checked (one extra conversation per page), and the chat uses it whenever you ask ("test the forms", "does the mobile menu work?"). It:

- **checks every link** on the page (broken, redirected, placeholder `#` links; `mailto:` and `tel:` are fine) and reads the **SEO and accessibility basics** (title, meta description, canonical, noindex, H1s and skipped heading levels, images without alt text or broken, unlabelled fields, unnamed buttons and links, insecure content, very large images);
- **uses the page like a visitor**: opens dropdowns and the mobile menu, clicks each distinct button and call to action, opens accordions, tabs and popups (and closes them with their X and with Escape);
- **tries every form**: sends it empty to see the required-field errors, types an invalid email, then fills it in with made-up test data;
- notes **console errors and failed requests** (404s, 500s, scripts or fonts that failed to load) seen along the way, ignoring analytics and chat-widget noise;
- can **call the site's API** (for example WordPress REST at `/wp-json/`) to confirm a failure.

**Nothing is sent unless you allow it.** By default the browser fills forms in and shows their validation, but stops the submission and any POST, PUT or DELETE request; reading pages and GET requests always work. The stopped send is listed for the agent as "blocked by Parity", the page stays as it was, and the agent is told never to report it as a bug. **Settings → AI Agents → Testing the page → Let the agent submit forms and send API requests** lets sends through to the site under review (test data only, each form once), for staging sites where test submissions are fine. Whatever the setting, the browser:

- stays on the site under review: a link to another site is stopped and listed, and pop-up windows and downloads are never opened;
- never opens WordPress admin, login or logout pages, and the link check never requests them (a logout link would sign you out);
- answers page dialogs (alerts, confirms) with OK, denies every permission (camera, location, notifications), and closes after a review, a new chat, ten idle minutes or when Parity quits;
- runs in a session of its own: your login cookies for the site are copied in, and nothing it does changes Parity's own browsing session.

Each browser step is saved as a screenshot (B1, B2, …) in the run, and a finding seen while testing uses that screenshot as its evidence picture, with the problem boxed. Findings read like the rest ("Contact link goes to a 404 page", "menu does not close on mobile", "form sends with an empty email"). The test runs at Desktop and Mobile when those are reviewed (otherwise at the one size reviewed); its rows are merged into the page's other findings, with Display set by Parity.

**Turning it off.** Untick **Reviews also test links, buttons, menus and forms** in Settings → AI Agents, untick **Also test links, forms and buttons** in the Multi-capture dialog for one batch, or use `/review --visual-only` for one review. **Cost:** the test is one more long conversation per page, with a screenshot per step.

## The agent's suggestions

Besides defects, the agent adds a few suggestions of its own (at most three per conversation): changes that would clearly help visitors although nothing is broken, like a form with no success message, a "Click here" button, a phone number that is not a tap-to-call link, or the main call to action far below the fold on mobile. They are rows like any other, with Status set to **ENHANCEMENT (QA)** (or "Suggestion:" at the start of Remarks in a tracker without that status), and the approval card marks them **Suggestion** so you can leave them out with one click. When there is a design, the design wins: the agent suggests only what it does not decide. Matters of taste are not suggested.

## History

**Past reviews** (the chat's *History* button, `/history`, or the command palette: "QA agent: past reviews") lists every run on this computer, newest first, filterable by page or project. A run shows:

- every hand-over: approved (how many rows were copied and left out), rejected (with your note) or not decided, each finding with its picture (loaded as you scroll) and the link that went in the sheet. **Copy rows again** puts exactly the rows that were pasted back on the clipboard;
- what the agent drafted for each size before any hand-over, from looking at the page and from testing it, with pictures made on demand, so a stopped run can still be looked at;
- **Open folder**, **Keep** (the automatic clean-up after 14 days, 30 runs or 2 GB never removes a kept run) and **Delete**.

Runs from before hand-overs were recorded are rebuilt from the rows that were copied and the pictures saved next to them.

**Chats** are saved as you talk (what the chat showed, its token counts, and what the agent remembers), up to 100. Open one from History (*Chats* tab) to read it or carry on: the agent remembers that chat's earlier messages again. *New chat* starts a fresh one and keeps the old one in History.

## How a review works

- **Capture.** For each breakpoint Parity loads the page you have open in a hidden, offscreen window at the design's width (using your existing WordPress login), scrolls it so lazy images and reveal animations fire, hides fixed elements except where a visitor would see them, and stitches a full-page image. It also reads the real computed values of every styled element and splits the page into sections (S1, S2, …).
- **Compare.** One fresh conversation per breakpoint. The agent looks at an overview (design left, live right, section boxes), matches sections to design areas, then looks at each section at full detail along with the live page's exact values (font, size, colour, spacing). Design sizes are estimates from the picture ("≈"); live values are exact.
- **Test.** Unless it is turned off, one more conversation opens the page in the agent's browser (see *Testing how the page works*) and saves what does not work.
- **Draft.** The agent saves rows with `save_draft` (`area: "functional"` for what it found by testing); a short text-only step merges the breakpoints and the test when there is more than one set. Only then is `finalize_rows` called, which waits for you.

The instructions every agent follows are in [`src/main/qaAgent/prompt.ts`](../src/main/qaAgent/prompt.ts) (also printed by `parity prompt`).

## Agents

| Agent | Uses | Status |
|---|---|---|
| Claude Code | your Claude plan | verified end to end against a real install |
| Codex | your ChatGPT plan | built from OpenAI's documentation; **not yet run against a real install** |
| Antigravity CLI (`agy`) | your Google plan | verified against agy 1.2.16: tool calls through the bridge, streamed text, token usage, and refusal of shell, web search and file reads (see below). Replaces Gemini CLI |
| Claude API key | your Anthropic key | tested against a fake server speaking the real streaming format; not run with a live key |
| OpenAI API key | your OpenAI key | tested against a fake Chat Completions server; not run with a live key |
| Gemini API key | your Gemini key (through Gemini's OpenAI-compatible endpoint) | as above |
| Local model | Ollama, LM Studio or any Chat Completions server | as above; the model must read pictures and use tools |

Agent apps (Claude Code, Codex, Antigravity CLI) run headless in a private temporary folder with **only Parity's tools** attached: no shell, no file access. Parity starts its local bridge just for that run if it is not already on. API keys are encrypted with the system keychain and never reach the app window.

### How Antigravity CLI is kept to Parity's tools

`agy` reads its settings and MCP servers from `~/.gemini`, refuses every tool that is not allowed in its `settings.json` when run headless, and lets some tools (web search) run without any permission. So for each run Parity:

1. makes a private temporary home folder and links in only your sign-in files (`oauth_creds.json`, `google_accounts.json`, `installation_id`). **Your own `~/.gemini` settings, rules, MCP servers and conversations are never read or changed**;
2. gives that home its own `settings.json` that allows only Parity's MCP tools (and reading agy's description files for them, and the file agy saves a large tool result to), and its own MCP server entry holding the bridge key (agy does not expand variables in headers, so the key sits in that folder until the run ends);
3. installs a `PreToolUse` hook that **denies every tool call except Parity's own** (shell, web search, agy's own browser, file reads and writes, sub-agents, scheduling, image generation; Parity's browser tools, with the rules above, are Parity's own). The only files it may read are those description files and the saved copy of a large Parity tool result, all inside the run's private folder. A hook that fails blocks the call, and if a tool ever runs without the hook having run, Parity stops the run;
4. sends the instructions and the question over stdin, never on the command line.

The private folder holds the bridge key and is deleted when the run ends. If Parity is killed mid-run it is left behind, and Parity removes any such folder older than 10 minutes the next time it starts.

The agent's attempts to use a refused tool come back to it as an error, and it carries on. Choose the model with Settings → AI Agents → Antigravity CLI → *List models* (`agy models`). **Windows:** `agy` starts the hook with `cmd /c`, and Go escapes quotes in a way `cmd` cannot read, so a hook command containing the app's quoted path fails with "is not recognized as an internal or external command". On Windows the hook command is therefore just `.\guard.cmd`, a batch file written next to `hooks.json` that does the quoting itself. The read permissions are granted with both slash styles. The Windows path (`USERPROFILE`, copied instead of linked login files, that batch file) has had this one real-world failure and is otherwise untested; if a run is stopped, the message now carries the reason from `agy`'s own log.

## Using it from a terminal or another agent

Turn on **Settings → AI Agents → Local bridge**. It listens on `127.0.0.1` only, needs a key (stored in a file only you can read), and serves the same tools two ways:

- **MCP** at `http://127.0.0.1:29849/mcp` for any MCP client. Send `Authorization: Bearer <key>`; the key file path is shown in settings.
- **The `parity` command** (install it from settings, or run `npm run parity -- <command>` in development): `parity context`, `parity capture desktop`, `parity section <run> desktop S2 --design 900:1900`, `parity finalize <run> rows.json`, `parity prompt`, … Run `parity --help` for the list. Exit codes: 0 ok, 1 the tool reported an error, 2 bad usage, 3 the bridge is unreachable.

An agent can only draft. `finalize_rows` always opens the approval card in Parity, whichever way it was called.

## Safety model

- **The bridge** answers only requests with the exact `127.0.0.1:<port>` Host header, refuses any request carrying an `Origin` header (so a web page cannot reach it, even by DNS rebinding), accepts only JSON POSTs to known paths, and requires the bearer key (compared in constant time). There is no lockout, because a lockout would let any web page lock you out.
- **Page content is data.** The instructions tell agents to treat everything on the page as data and to report page text that gives orders as a finding. The agents have no shell and cannot read or write files. `capture_live` only loads the page open in Parity (or the pages you listed for a batch) and refuses WordPress admin and login URLs. The agent's browser stays on that page's site, never opens admin, login or logout pages, and sends nothing unless you allowed it (see *Testing how the page works*); its rules are enforced by Parity on every request, not by the instructions.
- **Spreadsheet formulas.** Any cell that starts with `=`, `+`, `-` or `@` is prefixed with an apostrophe before it is copied, so page text cannot inject a formula into the tracker. (The approval card shows the text without the apostrophe.)
- **The approval gate** is in Parity's window, with a 15 minute timeout; closing the window counts as "not approved".

## Evidence screenshots

**The link in the sheet opens the Parity viewer** (`https://parity-gfx.pages.dev/?evidence=<id>`): a small page with the finding as its title, the picture (click to enlarge) and how long it stays available. The viewer reads `GET …/qa-evidence/<id>.json` (the finding, expiry and picture address; readable from the viewer site, still only by the unguessable id) and shows only pictures from this project's own evidence store. Builds without a viewer address (`VITE_EPHEMERAL_VIEWER_URL`) put the picture's own link in the sheet instead. The viewer is deployed by `.github/workflows/deploy-cloudflare.yml` on pushes to `main` that touch `viewer/**`; the `.json` lookup ships with the `qa-evidence` function.


Approving can upload each evidence picture (design crop beside live crop, the issue boxed) and put its link in the tracker's screenshot column. Pictures are stored privately in Supabase and served only by the `qa-evidence` function by an unguessable id (128-bit random) until they expire (default 90 days; 7 to 365 in settings). There is no way to list or overwrite them. **Anyone who has a link can view that picture until it expires.** Uploading needs your Parity account; without it the rows are still copied and the screenshot cell is left empty.

> **Deploying:** `supabase/migrations/20261004120000_create_qa_evidence.sql` and `supabase/functions/qa-evidence/` are deployed to production by `.github/workflows/deploy-supabase.yml` on any push to `main` that touches `supabase/**`. Run that workflow's dry-run first.

## Tests

```bash
npm test                              # unit tests, including the bridge with a real MCP client
npm run test:qa-capture:electron      # real Electron captures of a fixture page
npm run test:qa-flow:electron         # the main-process handshake: context, approval, clipboard, bridge
npm run test:qa-ui:electron           # renders the settings panel, chat, approval card, history and slots
npm run test:viewer:electron          # the viewer site's evidence page, with the evidence service answered locally
npm run test:qa-browser:electron      # the agent's browser on a local fixture site: clicks, forms, links, errors, dialogs,
                                      # the mobile menu, the API, and its rules (stays on the site, no admin, no sends unless allowed)
node scripts/test-qa-capture-electron.cjs --url <page> --width 1440 --bp desktop --out <dir>
                                      # capture any public page and write capture.png + capture.json
```

## Known limits

- Section matching between design and live is made by the agent from the overview and can be wrong; `designTop`/`designBottom` let it correct itself, and anything uncertain should come back as "needs a human look" rather than a row.
- Pages taller than 20,000px, or captures that take longer than a minute, are cut short with a warning.
- Full-screen overlays (cookie dialogs) are hidden; carousels are compared on their first slide.
- The Figma overlay itself still shows the single image you attached last; the per-breakpoint designs are stored alongside it for the agent.
- The agent's browser does not reach into iframes, so embedded third-party forms (HubSpot, Typeform, Calendly) and maps are seen but not tested. File-upload fields are not filled, and a reCAPTCHA can stop a real send even when sending is allowed.
