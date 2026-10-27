# hud — human quickstart

The desktop app, for people. Agents use the contract in [GUIDE.md](GUIDE.md).

- [Install](#install) · [Settings](#settings) · [Attention](#attention) · [Tickets](#tickets)

## Install

Download the installer for your platform from the
[latest release](https://github.com/CodeKnight314/hud/releases/latest): macOS (arm64/x64 DMG), Windows (x64 installer)
or Linux (x64 AppImage or deb). Builds are not notarized. On macOS, right-click the app and choose **Open** the first
time, and again after each update. Windows may show a SmartScreen prompt.

Open the app. It keeps one local board on your machine, with a window and a menu-bar or tray icon. Boards, backups
and the single-server lock live in the per-user data directory:

- macOS: `~/Library/Application Support/hud`
- Windows: `%APPDATA%\hud`
- Linux: `$XDG_DATA_HOME/hud`, or `~/.local/share/hud` when that variable is unset

From a source checkout, `npm install` then `npm run dev` runs the app against this repo on a scratch port and data
directory. `node bin/hud.js open` opens the board without the desktop shell.

## Settings

Open **Settings** from the app menu with ⌘, on macOS, or File → Settings (Ctrl+,) on Windows and Linux. The tray
menu has the same entry. Settings has two pages, **Connections** and **Updates**.

**Connections** lists Claude Code, Codex and OpenCode. **Registered** means the hud MCP entry is saved. It does not
mean an agent session is connected right now. **Connect** or **Repair** writes that entry. From the packaged app it
also installs the `hud` command. **Disconnect** removes only hud's entry. Configuration files are backed up first.
Restart or reconnect the client after a change so it reloads. **Copy configuration** is the snippet for any other MCP
client. **Install command** (or **Repair command**, once it is installed) is packaged-app only. A Linux AppImage
cannot install the command; use the `.deb` package.

**Updates** shows the installed version. **Check for updates** looks for the latest stable GitHub release. Drafts and
prereleases are ignored. **Download update** opens the matching installer in the browser. hud does not install it for
you. Use **Quit HUD for update**, replace the app, then reopen it. Boards stay in the data directory. **Check when
HUD opens** looks for a release at launch. Reconnect agent clients after an update so they pick up new tools.

## Attention

The left rail opens **attention** (`A`). It is the inbox for decisions waiting on you, blocked tickets, and monitors
that are in warning, error or stale. Rows are grouped by board, then by run.

**Review** records that you have seen an item. The item stays in the inbox. Review does not acknowledge agent alerts
and does not change the ticket or monitor. **Unreview** puts it back with the unreviewed rows. Snooze hides it for
15 minutes, one hour, or until tomorrow at 09:00. Opening a row inspects it and acknowledges nothing.

A decision is a ticket an agent paused with a choice. Pick an option in the inspector. The ticket moves to the status
that option names, and the agent that asked is notified.

**Mark since last visit read** clears the change list under the inbox. Press `?` for the rest of the keys. Runs, on
the same rail, are the longer jobs agents report.

## Tickets

**Tickets** in the footer (`l`) switches that board between the canvas and the ticket list. The canvas holds
monitors, notes and frames. Tickets stay in the list. A board that is mostly tickets opens the list, and the choice
is remembered per board.

Each row shows the ident (`KEY-12`), a status glyph, blockers and the branch. Sub-tickets nest under their parent.
Done and canceled rows stay hidden until **completed** is on. **＋ ticket** adds one inline. **＋ project** adds a
project, which owns the `KEY` that numbers its tickets.

Click a row to open the inspector: overview, activity and settings in one scroll. Status is `backlog`, `todo`,
`doing`, `review`, `blocked`, `done` or `canceled`. A ticket with unfinished blockers moves to `blocked` and returns
to `todo` when they finish. `⌘/Ctrl+K` searches titles, idents and bodies across boards.

Agents read and write these same tickets. Their contract is [GUIDE.md](GUIDE.md#projects-tickets-and-links).
