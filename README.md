# 🏙️ Agent Office

**Walk into your office. Your AI staff is already working.**

A self-hosted mobile "office" for running multiple AI coding agents (Claude Code, OpenAI Codex, xAI Grok) across all your projects — from your phone, like a group chat. Zero framework, zero database, two `npm` dependencies (`marked`, `web-push`). Two files of code.

[한국어 README](README.ko.md)

## The concept

- **Lobby** — every project is an *office*, shown as a card with a live activity badge (working / active today) and your plan-limit usage.
- **Enter an office** — your AI secretaries are there. Each has a name, a role, and a *different model behind it*. Give instructions in a chat room; work runs in that project's folder on your Mac.
- **Cross-check chain** — one toggle runs: executor (Claude) → auditor (Codex, reads the actual files skeptically) → chief of staff summarizes. Three vendors keeping each other honest.
- **Morning brief** — every day at 7:30 the chief of staff reads all your projects' recent sessions and pushes a prioritized briefing to your phone.

Default staff (rename/re-prompt them freely in `config.json`):

| Agent | Role | Backend |
|---|---|---|
| 🟣 아라 (Ara) | Chief of staff — coordinates, reports | `claude` |
| 🔵 무진 (Mujin) | Executor — does the work, can edit files | `claude` |
| 🟠 하연 (Hayeon) | Auditor — verifies with real evidence | `codex` |
| 🟢 제나 (Jena) | Strategist — trends, web search | `grok` |

## Features

- 📱 Messenger-grade chat UI (PWA, dark, timestamps, date separators, typing status)
- 🗂 Per-office file browser with in-app markdown rendering
- 📜 Browse your real Claude Code session history per project — and **continue any session from your phone** (`claude --resume`)
- 📊 Usage dashboard: Claude 5h/weekly limit %, Codex weekly %, Grok credits, today's tokens & cost (via [ccusage](https://github.com/ryoppippi/ccusage))
- 🔔 Web push notifications for every agent report and the morning brief
- ✅ TODO widget (`TODO.md` checkboxes per office)
- 🧰 Skill catalog viewer (renders your `~/.claude/skills/SKILLS_GUIDE.md`)

### Built to save tokens

- If Claude's 5-hour window hits **90%**, work is preemptively routed to Codex.
- If any backend fails or is rate-limited, the request **falls back across vendors** (claude → codex → grok) automatically.
- Everything cacheable is cached (usage 10 min, limits 5 min); the server itself calls no LLM — only your CLIs do, under your existing subscriptions.

## Quickstart

Requirements: macOS, Node 18+, [Claude Code](https://claude.com/claude-code) logged in. Optional: `codex` CLI, `grok` CLI (Grok Build), [Tailscale](https://tailscale.com) for phone access.

**One command:**

```sh
curl -fsSL https://raw.githubusercontent.com/MOSW626/agent-office/main/install.sh | bash
```

It checks prerequisites, clones to `~/agent-office`, installs the dependencies, creates your `config.json`, and (optionally, it asks) installs the [agent harness](#pairs-well-with-a-project-harness) and registers the 24/7 server + morning brief with launchd. Re-running it updates the install. Non-interactive flags:

```sh
curl -fsSL https://raw.githubusercontent.com/MOSW626/agent-office/main/install.sh | bash -s -- --all
# --with-harness   unlazy + gstack + gbrain
# --with-launchd   24/7 server + 07:30 brief
# --dir <path>     install location (default ~/agent-office)
```

<details>
<summary>Manual install</summary>

```sh
git clone https://github.com/MOSW626/agent-office.git && cd agent-office
npm install                      # marked + web-push
cp config.example.json config.json   # edit: your projects' paths, your agents
node server.mjs                  # → http://localhost:8787
```

</details>

### Phone access (Tailscale)

```sh
# once: enable HTTPS at https://login.tailscale.com/admin/dns
tailscale serve --bg 8787
# → https://<your-mac>.<tailnet>.ts.net  — open on phone, Add to Home Screen
```

HTTPS is required for push. After adding to home screen, tap 🔔 in the lobby.

### Run forever + morning brief (launchd)

Copy the two templates from [`setup/`](setup/) into `~/Library/LaunchAgents/`, fix the paths, then:

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.agenthub.server.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.agenthub.brief.plist
```

> ⚠️ macOS blocks launchd jobs whose log paths point into `~/Desktop` — keep logs in `~/Library/Logs/` (the templates already do).

### Limit % (Claude)

The dashboard reads your Claude Code OAuth token from the macOS Keychain to query the official usage endpoint. First call pops a Keychain dialog — choose **Always Allow**. The token never leaves your machine; only percentages are served.

## Pairs well with a project harness

Agent Office is the *remote control*; discipline comes from the harness your agents run inside. We built it alongside:

- [**unlazy**](https://github.com/Leonxlnx/unlazy) — completion discipline: decompose with a Depth Tree, define runnable GATES, verify with evidence. `npx skills add Leonxlnx/unlazy`
- [**gstack**](https://github.com/garrytan/gstack) — a 50+ skill team workflow (plan → review → QA → ship): `git clone --depth 1 https://github.com/garrytan/gstack.git ~/.claude/skills/gstack && cd ~/.claude/skills/gstack && ./setup`
- [**gbrain**](https://github.com/garrytan/gbrain) — persistent cross-session memory as an MCP server: `gbrain init --pglite`, then `claude mcp add --scope user gbrain -- gbrain serve`

Recommended layout: project knowledge in each project's `CLAUDE.md`, cross-project knowledge in gbrain, global rules in `~/.claude/CLAUDE.md` — and always open sessions from the project folder (context isolation is the cheapest hallucination fix).

## Architecture

```
index.html   PWA (vanilla JS, SSE live updates)
server.mjs   node:http — chat, orchestration, sessions, files, usage, push
config.json  your agents (persona prompts, backend, flags) + offices (paths)
data/        messages.jsonl, push subscriptions, VAPID keys (gitignored)
```

Agents are just headless CLI calls in the office's folder: `claude -p` / `codex exec` / `grok -p`, each with an `--append-system-prompt`-style persona. Adding a new backend is one branch in `callBackend()`.

## Security notes

- Bind is plain HTTP on your machine; expose it **only** through your tailnet (or LAN you trust). No auth layer is included by design — Tailscale is the perimeter.
- File APIs are restricted to registered project folders (path-escape checked).
- The executor agent gets `--permission-mode acceptEdits` only; widen per-project via that project's `.claude/settings.json`.

MIT © 2026
