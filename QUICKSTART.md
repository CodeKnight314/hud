# hud — human quickstart

hud runs as one local server with a browser board. Agents use the contract in [GUIDE.md](GUIDE.md).

- [Install](#install) · [First run](#first-run) · [Settings](#settings) · [Attention](#attention) ·
  [Tickets](#tickets) · [Updating](#updating) · [Agents](#agents)

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

## Attention

The rail's **Attention** page is the human inbox: decisions waiting on you, blocked tickets, monitor warnings and
errors, stale monitors, and command monitors that an agent created and needs approved. Reviewing an alert in the
inbox does not acknowledge agent alerts, and reviewing a command item does not approve it: approval is its own button,
and only the browser at the board can press it.

A command monitor runs a shell command as you, so it stays pending until you approve the exact command and working
directory shown. Editing the command later re-opens the approval.

## Tickets

Press `l` for the ticket list, or use the board canvas. A project key (`KEY`) gives its tickets `KEY-n` idents;
sub-tickets nest under their parent, blocked tickets name what they wait on, and the list tucks finished work away.
Every row shows the assignee (`→name`) and the live claimer (`⊕name`). `hud ls tickets` prints the same structure in
the terminal, and `hud queue` is the ready/open/claimed view agents work from.

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
