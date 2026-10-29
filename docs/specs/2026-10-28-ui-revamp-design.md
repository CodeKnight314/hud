# UI revamp: two views and a "needs you" badge

Status: approved 2026-10-28 (direction A). Branch `rtang/ui-ux-simplification`.

## Intent

hud is watched by one person while several agents work. Today the screens fight that. "Board" means four things,
the canvas is the landing page even when it holds one card, the ticket tree hides behind a status-bar button, the
Attention inbox is full of tickets that are only waiting on other tickets, and Runs is empty because the
decentralized playbook never tags a run. The learning curve is the problem to fix.

## Goals

- One top bar, and nothing else around the content.
- A visible toggle between the two views, with icons: **Tasks** (the animated ticket tree) and **Monitors** (the
  canvas). `l` still toggles.
- "Needs you" shows only what waits on the person: an agent question (`decision`), a command to approve
  (`command`), a monitor in error (`error`), and a ticket an agent marked blocked with nothing it waits on.
  A dependency-blocked ticket is not in it.
- Fewer concepts to learn. The UI says **workspace** where the API says board.

## Non-goals

- No change to the HTTP, MCP or CLI contract. `GET /api/attention` keeps every kind; "needs you" filters it in the
  browser. Agents keep `hud_attention`, `hud_runs` and `hud_queue`.
- No new status colour, no light mode.
- Settings (the Electron window) is untouched.

## Layout

```
hud   WORKSPACE ▾   [⑂ Tasks | 〜 Monitors]            ● N need you   search ⌘K   ● live   ⋯
```

- **Workspace picker** (`#btn-board` + `#board-menu`): the current workspace name. The menu lists workspaces
  with their "needs you" count, then new / rename / clear / delete.
- **View toggle** (`#view-toggle`, buttons `data-view="list"` and `data-view="canvas"`): inline SVG icons, a tree
  and a pulse. The choice is remembered per workspace. A workspace with tickets and no remembered choice opens on
  Tasks.
- **Needs you** (`#btn-attention`, popover `#needs`): the count, and a list of rows: glyph, kind word, title,
  workspace, and one action (answer, review for a command, open). Every action switches workspace and opens the
  details panel, so a command is approved only where its exact text and directory show. Empty state: "Nothing needs
  you."
- **⋯ menu** (`#more-menu`): agents (live sessions), organize, auto-organize, sources, activity, trash, help.
- **Monitors view** keeps fit and zoom as a small floating control in its bottom-right corner (`#canvas-ctl`).
- The details panel (drawer) is unchanged.

## Removed from the UI

- The left rail. Its contents move to the picker or the ⋯ menu.
- The Attention page and the Runs page (with its Queue tab). "Needs you" replaces Attention; the tree shows who
  holds what, which replaces the queue.
- The floating queue box on the canvas.
- The bottom status bar: the NORMAL/command-line mode, the hint text, the counters and the "tickets" button.
- The kanban "board" shape in Tasks. Tasks has tree (default) and list.
- In Tasks, the status / assignee / project / priority / tag / overdue / sort selects fold behind one "filter"
  button. Search, project chips and the tree/list switch stay visible.
- On monitor cards, the provenance footer (source, evidence, age, coverage). The details panel already shows it.

## Kept

Keyboard: `l` toggles the view, `t` new ticket, `m n f w` new canvas items, `.` fit, `+ −` zoom, `[ ]` switch
workspace, `?` help, ⌘K search, `A` opens "needs you". `R` and `:` go away with Runs and the command line.

## Left to the builder

Exact spacing, icon drawing, popover placement, and how much dead code goes with each removed surface. Each
removed surface's code goes too unless something still calls it. Headless UI checks are rewritten for the new
layout; the docs (QUICKSTART, GUIDE browser sections, PRODUCT, AGENTS, MCP instructions) follow.
