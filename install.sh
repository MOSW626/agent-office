#!/usr/bin/env bash
# Agent Office one-command installer
#   curl -fsSL https://raw.githubusercontent.com/MOSW626/agent-office/main/install.sh | bash
# Options (append after `bash -s --`):
#   --with-harness   also install unlazy + gstack + gbrain (agent discipline stack)
#   --with-launchd   run the server 24/7 + 07:30 morning brief (macOS launchd)
#   --all            everything above
#   --dir <path>     install location (default: ~/agent-office)
set -euo pipefail

REPO="https://github.com/MOSW626/agent-office.git"
DIR="${AGENT_OFFICE_DIR:-$HOME/agent-office}"
WITH_HARNESS=no
WITH_LAUNCHD=no
AUTO=no   # 플래그로 지정된 경우 프롬프트 없이 기본값으로 진행 (완전 비대화형)

while [ $# -gt 0 ]; do
  case "$1" in
    --with-harness) WITH_HARNESS=yes; AUTO=yes ;;
    --with-launchd) WITH_LAUNCHD=yes; AUTO=yes ;;
    --all) WITH_HARNESS=yes; WITH_LAUNCHD=yes; AUTO=yes ;;
    --dir) DIR="$2"; shift ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
  shift
done

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '  \033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

# Ask y/n even when piped through `curl | bash` (reads the terminal directly).
# AUTO=yes (any flag given) skips every prompt and takes the default.
ask() { # ask "question" default(y|n)
  local q="$1" def="${2:-n}" a=""
  if [ "$AUTO" = no ] && [ -r /dev/tty ]; then
    printf '  %s [%s] ' "$q" "$([ "$def" = y ] && echo Y/n || echo y/N)" > /dev/tty
    read -r a < /dev/tty || true
  fi
  a="${a:-$def}"
  case "$a" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

bold "🏙️  Agent Office installer"

# ── 1. prerequisites ─────────────────────────────────────────────
[ "$(uname -s)" = Darwin ] || warn "not macOS — the app runs, but launchd/Keychain features are macOS-only"
command -v git  >/dev/null || die "git not found — install Xcode Command Line Tools: xcode-select --install"
command -v node >/dev/null || die "Node.js not found — install Node 18+ (https://nodejs.org or: brew install node)"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 18 ] || die "Node 18+ required (found $(node -v))"
ok "git + node $(node -v)"
if command -v claude >/dev/null; then
  ok "claude CLI found"
else
  warn "claude CLI not found — agents won't run until you install Claude Code: npm install -g @anthropic-ai/claude-code"
fi
command -v codex >/dev/null && ok "codex CLI found (auditor enabled)" || warn "codex CLI not found (optional — auditor agent disabled)"
command -v grok  >/dev/null && ok "grok CLI found (strategist enabled)" || warn "grok CLI not found (optional — strategist agent disabled)"

# ── 2. clone or update ───────────────────────────────────────────
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" pull --ff-only || die "could not update $DIR (local changes? run: git -C $DIR status)"
  ok "updated existing checkout: $DIR"
elif [ -e "$DIR" ]; then
  die "$DIR exists but is not a git checkout — move it or rerun with --dir <path>"
else
  git clone --depth 1 "$REPO" "$DIR"
  ok "cloned → $DIR"
fi

# ── 3. deps + config ─────────────────────────────────────────────
(cd "$DIR" && npm install --silent)
ok "npm install (marked, web-push)"
if [ ! -f "$DIR/config.json" ]; then
  cp "$DIR/config.example.json" "$DIR/config.json"
  ok "config.json created from example — edit it with your project paths"
else
  ok "config.json kept (already exists)"
fi

# ── 4. optional: agent harness (unlazy + gstack + gbrain) ────────
if [ "$WITH_HARNESS" = no ] && ask "Install the agent harness too? (unlazy + gstack + gbrain)" n; then
  WITH_HARNESS=yes
fi
if [ "$WITH_HARNESS" = yes ]; then
  bold "— harness —"
  # unlazy: completion discipline skill
  if [ -d "$HOME/.claude/skills/unlazy" ]; then
    ok "unlazy already installed"
  else
    npx --yes skills add Leonxlnx/unlazy && ok "unlazy installed" || warn "unlazy install failed — retry later: npx skills add Leonxlnx/unlazy"
  fi
  # bun (needed by gstack & gbrain)
  if ! command -v bun >/dev/null && [ ! -x "$HOME/.bun/bin/bun" ]; then
    if command -v brew >/dev/null && { [ "$AUTO" = yes ] || ask "gstack/gbrain need Bun — install via Homebrew?" y; }; then
      brew install oven-sh/bun/bun || warn "bun install failed — gstack/gbrain will be skipped"
    else
      warn "Bun missing — skipping gstack/gbrain (install bun, then rerun with --with-harness)"
    fi
  fi
  export PATH="$HOME/.bun/bin:$PATH"
  if command -v bun >/dev/null; then
    # gstack: 50+ skill team workflow
    if [ -d "$HOME/.claude/skills/gstack" ]; then
      ok "gstack already installed"
    else
      git clone --depth 1 https://github.com/garrytan/gstack.git "$HOME/.claude/skills/gstack" \
        && (cd "$HOME/.claude/skills/gstack" && ./setup) \
        && ok "gstack installed" || warn "gstack setup failed — see https://github.com/garrytan/gstack"
    fi
    # gbrain: persistent memory via MCP
    if command -v gbrain >/dev/null; then
      ok "gbrain already installed"
    else
      GB="$HOME/gbrain"
      [ -d "$GB/.git" ] || git clone --depth 1 https://github.com/garrytan/gbrain.git "$GB"
      (cd "$GB" && bun install && bun link) \
        && gbrain init --pglite \
        && { command -v claude >/dev/null && claude mcp add --scope user gbrain -- gbrain serve || true; } \
        && ok "gbrain installed (PGLite, keyless mode) + MCP registered" \
        || warn "gbrain setup failed — see https://github.com/garrytan/gbrain"
    fi
  fi
fi

# ── 5. optional: launchd (24/7 server + 07:30 morning brief) ─────
if [ "$(uname -s)" = Darwin ]; then
  if [ "$WITH_LAUNCHD" = no ] && ask "Run the server 24/7 + daily 07:30 morning brief? (launchd)" n; then
    WITH_LAUNCHD=yes
  fi
  if [ "$WITH_LAUNCHD" = yes ]; then
    bold "— launchd —"
    NODE_BIN="$(command -v node)"
    LA="$HOME/Library/LaunchAgents"
    mkdir -p "$LA" "$HOME/Library/Logs"
    # note: logs must NOT live under ~/Desktop — macOS blocks the spawn (EX_CONFIG)
    sed -e "s|/opt/homebrew/bin/node|$NODE_BIN|" \
        -e "s|/Users/YOU/path/to/agent-office|$DIR|" \
        -e "s|/Users/YOU|$HOME|g" \
        "$DIR/setup/com.agenthub.server.plist" > "$LA/com.agenthub.server.plist"
    cp "$DIR/setup/com.agenthub.brief.plist" "$LA/com.agenthub.brief.plist"
    launchctl bootout  gui/$(id -u)/com.agenthub.server 2>/dev/null || true
    launchctl bootout  gui/$(id -u)/com.agenthub.brief  2>/dev/null || true
    launchctl bootstrap gui/$(id -u) "$LA/com.agenthub.server.plist"
    launchctl bootstrap gui/$(id -u) "$LA/com.agenthub.brief.plist"
    ok "server + morning brief registered (logs: ~/Library/Logs/agenthub.log)"
  fi
fi

# ── 6. done ──────────────────────────────────────────────────────
echo
bold "Done. Next steps:"
echo "  1. Edit $DIR/config.json — point \"projects\" at your real folders"
if [ "$WITH_LAUNCHD" = yes ]; then
  echo "  2. Open http://localhost:8787 (server is already running via launchd)"
else
  echo "  2. Start it:  node $DIR/server.mjs   → http://localhost:8787"
fi
echo "  3. Phone access: enable HTTPS at https://login.tailscale.com/admin/dns, then:  tailscale serve --bg 8787"
echo "  4. On your phone: open the https URL → Add to Home Screen → tap 🔔 for push"
