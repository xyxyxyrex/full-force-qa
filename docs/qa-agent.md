# QA agent

An AI agent that does the first pass of visual QA: it compares the live staging page with the Figma exports, one breakpoint and section at a time, drafts the differences as rows for the master tracker, and hands them to you. **You approve the rows in Parity before anything is copied or uploaded.**

## The workflow

1. **Store the designs.** Open the project, open the Figma overlay panel and drop the Figma PNGs on the Desktop, Tablet and Mobile slots (or just drop several at once: each goes to its detected breakpoint). Parity works out the export scale (1x, 2x, 3x) from the file name or its width and shows it, so you can correct it.
   **Designs are kept per page.** The slots show the page they belong to ("For page /alopecia-page") and follow the page that is open: change the URL inside the project and the slots switch to that page's PNGs (empty if it has none yet), so a design is never compared with the wrong page. The chat header shows the same thing before you run anything: the page, and the PNG loaded for each breakpoint, with a warning for any that is missing. **The overlay follows the viewport.** With Desktop, Tablet and Mobile PNGs stored for the page, the Figma overlay shows the one for the breakpoint the viewport is at (under 600px wide is Mobile, 600–1199px Tablet, 1200px and up Desktop): switch the viewport and the overlay switches with it. A breakpoint with no PNG shows an empty overlay and a note, never an image of another size. Pasting or dropping a PNG moves the viewport to the breakpoint it belongs to, so a mobile PNG pasted while viewing Desktop switches to Mobile and shows. A review states the page and the designs it is using as its first message. Designs saved before this change move to the page they were added for the first time that page is opened.
2. **Tracker format.** The standard tracker is built in: Page Link, Section, Screenshot, Remarks, Priority (QA/PM), Display, Status, Approval Screenshot(QA), Reason for Rejection, Screenshot and Remarks (Dev), Remarks (PM), Remarks (CRSM). The agent fills Page Link, Section, Remarks and Priority, Parity fills Screenshot with the evidence link, and the Dev, PM, CRSM and approval columns stay empty. Display is a dropdown (Desktop, Mobile, Tablet, Mobile & Tablet, Desktop and Mobile, Desktop and Tablet) and the agent picks where the issue appears; Parity rejects anything outside the list. Status is left empty because developers and the approval step set it, except "ENHANCEMENT (QA)" for suggestions. To use a different tracker, paste its header row and two or three example rows in Settings → AI Agents → Tracker format.
3. **Pick an agent** (Settings → AI Agents) and open the QA chat (`Ctrl+Shift+Q` or the chat button in the top bar). The chat opens on the right and takes the place of the inspector until you close it.
4. **Talk to it or run a review.** Type a question ("how big is the hero heading on mobile?", "recheck the footer") and the agent answers using the live page and your designs. It remembers the conversation until you press *New chat*. `/review` runs the full review of every breakpoint that has a design; `/review desktop mobile --agent codex` narrows it. `/stop` (or Esc) stops the agent, `/agents` lists the agents, `/help` lists the commands.
   The header shows token use: the total for this chat with input and output split, what the current message has used so far, and (on hover) the size of the conversation the agent is holding. Every request re-sends the conversation, so input tokens add up faster than the text on screen. If you set a token limit in Settings → AI Agents it applies to each message and each review. Some agent programs do not report usage; the meter then shows a dash.
5. **Approve.** An approval card shows the drafted rows, the severity counts and the evidence pictures. *Approve & copy* puts the rows on your clipboard (and uploads the evidence pictures, if enabled); *Reject* sends your note back to the agent.
6. **Paste into the tracker.**

## How a review works

- **Capture.** For each breakpoint Parity loads the page you have open in a hidden, offscreen window at the design's width (using your existing WordPress login), scrolls it so lazy images and reveal animations fire, hides fixed elements except where a visitor would see them, and stitches a full-page image. It also reads the real computed values of every styled element and splits the page into sections (S1, S2, …).
- **Compare.** One fresh conversation per breakpoint. The agent looks at an overview (design left, live right, section boxes), matches sections to design areas, then looks at each section at full detail along with the live page's exact values (font, size, colour, spacing). Design sizes are estimates from the picture ("≈"); live values are exact.
- **Draft.** The agent saves rows with `save_draft`; for several breakpoints a short text-only step merges them. Only then is `finalize_rows` called, which waits for you.

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
3. installs a `PreToolUse` hook that **denies every tool call except Parity's own** (shell, web search, browser, file reads and writes, sub-agents, scheduling, image generation). The only files it may read are those description files and the saved copy of a large Parity tool result, all inside the run's private folder. A hook that fails blocks the call, and if a tool ever runs without the hook having run, Parity stops the run;
4. sends the instructions and the question over stdin, never on the command line.

The private folder holds the bridge key and is deleted when the run ends. If Parity is killed mid-run it is left behind, and Parity removes any such folder older than 10 minutes the next time it starts.

The agent's attempts to use a refused tool come back to it as an error, and it carries on. Choose the model with Settings → AI Agents → Antigravity CLI → *List models* (`agy models`). The Windows path (`USERPROFILE`, copied instead of linked login files) is untested.

## Using it from a terminal or another agent

Turn on **Settings → AI Agents → Local bridge**. It listens on `127.0.0.1` only, needs a key (stored in a file only you can read), and serves the same tools two ways:

- **MCP** at `http://127.0.0.1:29849/mcp` for any MCP client. Send `Authorization: Bearer <key>`; the key file path is shown in settings.
- **The `parity` command** (install it from settings, or run `npm run parity -- <command>` in development): `parity context`, `parity capture desktop`, `parity section <run> desktop S2 --design 900:1900`, `parity finalize <run> rows.json`, `parity prompt`, … Run `parity --help` for the list. Exit codes: 0 ok, 1 the tool reported an error, 2 bad usage, 3 the bridge is unreachable.

An agent can only draft. `finalize_rows` always opens the approval card in Parity, whichever way it was called.

## Safety model

- **The bridge** answers only requests with the exact `127.0.0.1:<port>` Host header, refuses any request carrying an `Origin` header (so a web page cannot reach it, even by DNS rebinding), accepts only JSON POSTs to known paths, and requires the bearer key (compared in constant time). There is no lockout, because a lockout would let any web page lock you out.
- **Page content is data.** The rubric tells agents to treat everything on the page as data, and the tools cannot browse, click or write. `capture_live` only loads the page open in Parity and refuses WordPress admin and login URLs.
- **Spreadsheet formulas.** Any cell that starts with `=`, `+`, `-` or `@` is prefixed with an apostrophe before it is copied, so page text cannot inject a formula into the tracker. (The approval card shows the text without the apostrophe.)
- **The approval gate** is in Parity's window, with a 15 minute timeout; closing the window counts as "not approved".

## Evidence screenshots

Approving can upload each evidence picture (design crop beside live crop, the issue boxed) and put its link in the tracker's screenshot column. Pictures are stored privately in Supabase and served only by the `qa-evidence` function by an unguessable id (128-bit random) until they expire (default 90 days; 7 to 365 in settings). There is no way to list or overwrite them. **Anyone who has a link can view that picture until it expires.** Uploading needs your Parity account; without it the rows are still copied and the screenshot cell is left empty.

> **Deploying:** `supabase/migrations/20261004120000_create_qa_evidence.sql` and `supabase/functions/qa-evidence/` are deployed to production by `.github/workflows/deploy-supabase.yml` on any push to `main` that touches `supabase/**`. Run that workflow's dry-run first.

## Tests

```bash
npm test                              # unit tests, including the bridge with a real MCP client
npm run test:qa-capture:electron      # real Electron captures of a fixture page
npm run test:qa-flow:electron         # the main-process handshake: context, approval, clipboard, bridge
npm run test:qa-ui:electron           # renders the settings panel, chat, approval card and slots
node scripts/test-qa-capture-electron.cjs --url <page> --width 1440 --bp desktop --out <dir>
                                      # capture any public page and write capture.png + capture.json
```

## Known limits

- Section matching between design and live is made by the agent from the overview and can be wrong; `designTop`/`designBottom` let it correct itself, and anything uncertain should come back as "needs a human look" rather than a row.
- Pages taller than 20,000px, or captures that take longer than a minute, are cut short with a warning.
- Full-screen overlays (cookie dialogs) are hidden; carousels are compared on their first slide.
- The Figma overlay itself still shows the single image you attached last; the per-breakpoint designs are stored alongside it for the agent.
