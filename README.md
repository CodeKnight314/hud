<p align="center"><img src="build/icon.svg" width="88" alt="hud"></p>

<h1 align="center">hud</h1>

<p align="center">A local coordination board for you and your agents.</p>

hud is a desktop app backed by one local server. You and your agents share a fixed board of tickets, monitors, notes
and charts. The board grants exclusive leases, takes work back from an agent that goes silent, and treats a ticket
tree as the owned decomposition of a job. Agents reach it through MCP, the CLI or HTTP. It runs on your machine, binds
to loopback only, and keeps your data in a per-user directory. The contract is [PRODUCT.md](PRODUCT.md).

People start with the [human quickstart](QUICKSTART.md); agents use [GUIDE.md](GUIDE.md).

## Install

Download the installer for your platform from the [latest stable release](https://github.com/CodeKnight314/hud/releases/latest): macOS (arm64/x64 DMG), Windows (x64 installer)
or Linux (x64 AppImage or `.deb`). A signed release opens normally: macOS is Developer ID–signed and notarized, and Windows
is Authenticode-signed. Unsigned builds — a release produced without signing secrets, or a package built on your own
machine — still need a first-launch bypass: on macOS, right-click the app and choose **Open**; Windows may show a
SmartScreen prompt. Choose Settings → Connections → **Install command** to add the agent command. If you move an
AppImage, run that action again so the command follows the file.

From a source checkout:

```sh
npm install
npm run dev      # Electron against this repo, scratch port and data dir
npm run pack     # unpacked app in dist/
```

The app is the primary interface; `node bin/hud.js open` opens the board without the desktop shell.

## What you get

- **Tickets with real structure.** A project key (`KEY`) gives its tickets `KEY-n` idents. A parent owns its
  decomposition. Dependencies, assignees, decisions and a Linear-style list view. A `run` ticket can summarize a whole job.
- **Monitors that stay honest.** Command, HTTP, probe and cron-heartbeat sources with thresholds, staleness, history,
  24 h uptime and alerts. Readings carry provenance, evidence and freshness.
- **A live board.** Frames, notes, utilities, annotations, comparisons, and a fixed 1600 × 900 surface that you and
  agents arrange together.
- **Attention and runs.** One inbox for decisions, blocked work, warnings, errors and stale monitors; a run view with
  explicit progress and ETA.
- **Coordination for several agents.** The board enforces exclusive leases. A silent agent loses its hold, and a
  live lease stays with its holder. A queue, typed context, attachments and an event-driven wait let agents share findings.

## Connect an agent

```sh
hud mcp install        # register hud with Claude Code, Codex and OpenCode
hud mcp status         # what is configured where
hud mcp print generic  # a snippet for any other MCP client
```

The packaged app installs its own `hud` command first (`hud cli install`, or **Install command** in Settings). A source
checkout uses `node bin/hud.js` instead. On Linux, the AppImage and the `.deb` both register that command for MCP.

Agents get the full surface, documented in the guide (`hud guide`, `hud://guide`, `GET /api/guide`). A session keeps its
old MCP process after an upgrade — reconnect it (`/mcp`, `hud status`, or `hud mcp reconnect` for the checklist).

## Coordination quickstart

```sh
hud queue                                   # ready / open / claimed work
hud claim EGO-3 --start                     # exclusive lease; moves it to doing
hud context publish --scope board:main --kind FACT --text "parser drops trailing commas"
hud context read --scope board:main         # delta reads since your cursor
hud wait --scope board:main --timeout 20    # wake on a peer publish or session end
hud attach add notes.md --scope board:main  # share a file by reference
```

When several agents share a board, follow one playbook:

```sh
hud guide decentralized    # everyone pulls ready work
hud guide lead             # one lead links and assigns; the others pull
```

See [GUIDE.md](GUIDE.md#coordination) and [PLAYBOOKS.md](PLAYBOOKS.md).

## Everyday use

Press `?` in the app for the full key map. The left rail switches Attention, Runs and boards; `⌘/Ctrl+K` searches
everything; `l` toggles the canvas and ticket list; `:` opens the command palette. A single inspector on the right
holds overview, activity, coordination and settings in one scroll.

## Learn more

- [QUICKSTART.md](QUICKSTART.md) — install, Settings, Attention and Tickets.
- [PRODUCT.md](PRODUCT.md) — the product contract: leases, reclaim, trees, and which issue serves which criterion.
- [GUIDE.md](GUIDE.md) — the agent and operator guide: tools, schemas, renderers, coordination, install and updates.
- [STYLE.md](STYLE.md) — the dark desktop visual contract.
- [AGENTS.md](AGENTS.md) — architecture and contributor conventions.
- [views/README.md](views/README.md) — writing or generating chart renderer modules.

## Security

hud binds to `127.0.0.1`/`::1`, rejects foreign `Host`/`Origin` headers, and sends a strict CSP. Command monitors and `apply` run with your permissions, so review anything an agent asks hud to execute. Your board, backups and the
single-server lock live in the per-user data directory (`~/Library/Application Support/hud` on macOS, `%APPDATA%\hud` on Windows, `~/.local/share/hud` elsewhere).
