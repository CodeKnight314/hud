<p align="center"><img src="build/icon.svg" width="88" alt="hud"></p>

<h1 align="center">hud</h1>

<p align="center">A local coordination board for you and your agents.</p>

hud is one local server with a browser board. You and your agents share a fixed board of tickets, monitors, notes and
charts. The board grants exclusive leases, takes work back from an agent that goes silent, and treats a ticket tree as
the owned decomposition of a job. Agents reach it through MCP, the CLI or HTTP. It runs on your machine, binds to
loopback only, and keeps your data in a per-user directory. The contract is [PRODUCT.md](PRODUCT.md).

People start with the [human quickstart](QUICKSTART.md); agents use [GUIDE.md](GUIDE.md).

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/CodeKnight314/hud/main/scripts/install.sh | sh
```

Windows (PowerShell): `irm https://raw.githubusercontent.com/CodeKnight314/hud/main/scripts/install.ps1 | iex`

The installer downloads the latest stable release from
[GitHub Releases](https://github.com/CodeKnight314/hud/releases/latest), checks it against the release's `SHA256SUMS`,
and puts `hud` in `~/.hud/bin`, adding it to `PATH` (a symlink into a PATH directory, otherwise a marked block in your
shell rc; `HUD_NO_PATH_EDIT=1` skips that). It needs Node.js 18 or newer; there is no app bundle and no code signing. Then:

```sh
hud            # start the server if needed and open the board in your browser
hud status     # pid, port, data dir, save health
hud update     # install the next release (same checksum check); --check only reports
```

From a checkout: `npm install`, then `npm run dev` (Electron on a scratch port) or `node bin/hud.js`.

## What you get

- **Tickets with real structure.** A project key gives its tickets `KEY-n` idents; a parent owns its decomposition.
  Dependencies, assignees, decisions and a Linear-style list view; a `run` ticket can summarize a whole job.
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

`hud mcp install` registers the installed launcher, so a client never depends on `PATH`.
Agents get the full surface, documented in the guide (`hud guide`, `hud://guide`, `GET /api/guide`).
`hud guide --section <anchor>` and `GET /api/guide?section=<anchor>` return one table-of-contents slice; the bare
commands still return the whole guide. A session keeps its old MCP process after an upgrade — reconnect it (`/mcp`,
`hud status`, or `hud mcp reconnect` for the checklist).

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

Press `?` for the full key map. The left rail switches Attention, Runs and boards; `⌘/Ctrl+K` searches everything;
`l` toggles canvas and list; `:` opens the command palette. One inspector scrolls overview, activity and settings.

## Learn more

- [QUICKSTART.md](QUICKSTART.md) — install, first run, updates, the board, agents.
- [PRODUCT.md](PRODUCT.md) — the product contract: leases, reclaim, trees, and which issue serves which criterion.
- [GUIDE.md](GUIDE.md) — the agent and operator guide: tools, schemas, renderers, coordination, install and updates.
- [STYLE.md](STYLE.md) — the dark desktop visual contract.
- [AGENTS.md](AGENTS.md) — architecture and contributor conventions.
- [views/README.md](views/README.md) — writing or generating chart renderer modules.

## Security

hud binds to `127.0.0.1`/`::1`, rejects foreign `Host`/`Origin` headers, and sends a strict CSP. Command monitors and `apply` run with your permissions, so review anything an agent asks hud to execute. Your board, backups and the
single-server lock live in the per-user data directory (`~/Library/Application Support/hud` on macOS, `%APPDATA%\hud` on Windows, `~/.local/share/hud` elsewhere).
