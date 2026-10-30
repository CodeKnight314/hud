# hud — human quickstart

hud runs as one local server with a browser board. Agents use the contract in [GUIDE.md](GUIDE.md).

- [Install](#install) · [First run](#first-run) · [Settings](#settings) · [Needs you](#needs-you) ·
  [Tasks and Monitors](#tasks-and-monitors) · [Updating](#updating) · [Agents](#agents)

## Install

hud is a terminal install. Node.js 18 or newer is the only prerequisite.

```sh
curl -fsSL https://raw.githubusercontent.com/CodeKnight314/hud/main/scripts/install.sh | sh
```

Windows, in PowerShell: `irm https://raw.githubusercontent.com/CodeKnight314/hud/main/scripts/install.ps1 | iex`

The installer fetches the latest [stable release](https://github.com/CodeKnight314/hud/releases/latest), verifies it
against that release's `SHA256SUMS`, and writes `~/.hud/bin/hud` (Windows: `%USERPROFILE%\.hud\bin\hud.cmd`). It also
puts that directory on your `PATH`: a symlink into a directory that is already there, otherwise a marked block in your
shell rc (`HUD_NO_PATH_EDIT=1` opts out). Open a new terminal afterwards. There is no app bundle, no installer to
trust, and no Gatekeeper or SmartScreen dialog: nothing is signed, and nothing needs to be.

## First run

```sh
hud                # start the server if it is not running, then open the board in your browser
```

That prints the board URL and keeps one server per data directory. Useful neighbours:

```sh
hud status         # pid, port, mode, data dir, save health
hud stop           # stop the background server
hud reveal         # open the data directory
```

Your board, backups and the single-server lock live in the per-user data directory:

- macOS: `~/Library/Application Support/hud`
- Windows: `%APPDATA%\hud`
- Linux: `$XDG_DATA_HOME/hud`, or `~/.local/share/hud` when that variable is unset

The server logs to `<data>/server.log`. Command monitors run with your permissions, so treat anything an agent asks
hud to execute the way you would treat a pasted shell command.

The browser has one top bar. The **workspace picker** names the current workspace (the CLI and agents call it a
*board*) and lists the others with their "needs you" counts, plus new, rename, clear and delete; `[` and `]` step
through them. Next come the [Tasks / Monitors](#tasks-and-monitors) toggle, the [needs you](#needs-you) badge,
search (`⌘/Ctrl+K`, across every workspace) and the connection pill. The **⋯** menu holds the live agent sessions,
organize and auto-organize, sources, activity, trash and help (`?` lists every key).

## Settings

There is no settings window: the install directory holds the program, the data directory holds the board. What a
desktop Settings screen used to do is a command:

| Want | Run |
|---|---|
| Register hud with Claude Code, Codex and OpenCode | `hud mcp install` |
| See what is registered where | `hud mcp status` |
| Print a snippet for another MCP client | `hud mcp print generic` |
| Remove the entries again | `hud mcp uninstall` |
| Open the data directory | `hud reveal` |

## Needs you

The **needs you** badge counts what waits on you across every workspace; click it or press `A` for the list:

- **decision**: an agent asked a question and waits for you to pick an option.
- **command**: an agent added or changed a command monitor, which will not run until you approve it.
- **error**: a monitor is in error.
- **blocked**: an agent marked a ticket blocked and it waits on no other ticket, so it waits on you.

A ticket that only waits on another ticket is left out: it clears itself when that ticket finishes. Each row has one
action that switches to its workspace and opens the details panel: **answer**, **review** for a command, or **open**. Approval
is its own button, and only the browser at the board can press it: a command monitor runs a shell command as you, so it
stays pending until you approve the exact command and working directory shown, and editing the command re-opens the
approval. Agents still read every kind, warnings and stale monitors included, with `hud attention`.

## Tasks and Monitors

The icon toggle in the top bar switches a workspace between its two views, and `l` does the same. Each workspace
remembers its view; one that has tickets opens on Tasks.

**Tasks** is the work, drawn as a live radial tree that always fits the window. A project key (`KEY`) gives its tickets
`KEY-n` idents. The root sits in the centre (several roots hang off a small hub), parent tickets sit on rings around it,
and every leaf sits on the outer ring with its ident and status glyph; a finished leaf shrinks to a green dot (hollow
when canceled). Gray is todo, yellow in progress, green done, red blocked or waiting on your decision. A curve joins a
sub-ticket to its parent, an arrow marks a ticket that waits on another, a ring means an agent holds the ticket, and a
ripple means an agent just published context about it. **hide done** drops branches whose work is all finished. Hover a node for its title, assignee and claimer;
click it for details. **list** shows the same work as rows: sub-tickets nest under their parent, each row shows the
assignee (`→name`) and live claimer (`⊕name`), and finished work is tucked away. Search, project chips and the
tree/list switch stay in view; status, assignee, project, priority, tag, overdue and sort sit behind **filter**. `t`
adds a ticket. `hud ls tickets` prints the same tree in a terminal; `hud queue` is the ready work agents pull from.

**Monitors** is the canvas: monitor cards and the frames, notes and utilities around them, on a fixed 1600 × 900
surface. Fit (`.`) and zoom (`+` `−`) sit in its bottom-right corner, `m` `n` `f` `w` add a monitor, note, frame or
widget, and double-clicking a card opens its details.

## Updating

```sh
hud update --check   # is there a newer stable release?
hud update           # download, verify SHA256SUMS, swap the install, restart the server if it was running
```

The install is replaced in place at `~/.hud/app`; your board in the data directory is untouched. Agent sessions keep
their old MCP process, so reconnect them (`/mcp` in Claude Code) to load new tools — `hud mcp reconnect` prints the
one-shot checklist of clients that are still on the previous version.

## Agents

```sh
hud mcp install      # Claude Code, Codex and OpenCode entries pointing at ~/.hud/bin/hud
hud mcp status       # read-only: what is registered
```

Agents get tickets, monitors, charts, coordination and the guide (`hud guide`, `hud://guide`, `GET /api/guide`).
When several agents share a board they follow one playbook: `hud guide decentralized` (everyone pulls ready work) or
`hud guide lead` (one lead links and assigns, the others pull).
