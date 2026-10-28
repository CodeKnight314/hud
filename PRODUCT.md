# hud — product definition

hud is a local board a person and several agents share. The board coordinates the work. The person and the agents do the work. Monitors, notes and frames sit on the same board. MCP, the CLI and HTTP are one contract. Tool shapes and timings live in [GUIDE.md](GUIDE.md#coordination).

The three rules below are the contract in this repo. The live Linear HUD project description does not state them. Copying this block into Linear is a separate step, and it is out of scope for the change that added this page. Issues RIC-7 through RIC-37 each map to one criterion. RIC-11, RIC-13, RIC-15, RIC-17, RIC-19, RIC-28, RIC-31, RIC-33, RIC-34, RIC-36 and RIC-37 have landed on 0.2.0; the other rows are still open.

## Surfaces

The canvas and the tree carry different objects. The **canvas** is for monitors: monitor cards, their charts, and the
frames, notes and utilities that group or annotate them. The **tree** is for the work: tickets and projects, with
`parent` as the ownership edge and `blockedBy` as the dependency. A ticket or a project has no canvas position;
creating or patching one with `x`/`y`/`w`/`h` is refused, and the canvas menu does not create tickets. This split is
what keeps monitors glanceable and tasks searchable.

## Three rules

hud is a local coordination board for a person and several agents. Three rules hold:

1. **Board-enforced leases.** Only the board grants an exclusive hold on a ticket. A live lease stays with its holder. One session holds one unfinished ticket. An assignee is durable ownership and blocks everyone else.
2. **Reclaim of stuck agents.** A session that goes silent loses its leases. An expired lease returns to the queue. Takeover is allowed only once the holder's session is no longer live. A server restart drops every lease, because leases are not saved. Finishing, canceling or reassigning releases the lease.
3. **Clear decomposition ownership (trees).** The parent ticket owns the split. Its children are that decomposition. A dependency (`blockedBy`) is not ownership. The parent remains a coordination node.

## Board-enforced leases

A claim is a lease the store grants. A second caller gets `409` `claimed`. The holder renews it by claiming again or by the session heartbeat. `start` moves the ticket to `doing` and is refused while the ticket is blocked (`blocked`). A session that already holds an unfinished ticket gets `one-claim`. A ticket assigned to someone else gets `assigned`. A finished ticket gets `finished`.

The queue is the read model: ready work, then claimed, then done. A lead may pre-assign and link; everyone else pulls a ready row. Both are policies over the same leases.

Landed: [RIC-13](https://linear.app/richards-project-space/issue/RIC-13/define-agent-coordination-playbooks-decentralized-vs-lead) is [PLAYBOOKS.md](PLAYBOOKS.md), the copy-paste playbook for those two policies (claim, publish a fact, wait, finish), including expired lease, blocked ticket and assignee conflict. [RIC-33](https://linear.app/richards-project-space/issue/RIC-33/claimqueue-visibility-on-the-board-canvas) is the canvas queue widget: the holder, the remaining lease, and the ready count. Open work: the claim/release smoke in [RIC-10](https://linear.app/richards-project-space/issue/RIC-10/complete-mcp-surface-for-trees-projects-claims) keeps lease visibility on the shared tool matrix (that issue's criterion is one contract).

## Reclaim of stuck agents

A session that stops heartbeating ends, and its leases release with it. A lease past its time-to-live releases on its own. While the holder is still live, takeover leaves the lease where it is. Once that session is gone and the lease has not yet expired, the next agent reclaims it with takeover (`hud claim <id> --takeover`). The lease also ends when the ticket is finished, canceled, trashed or reassigned, and when its board is cleared or deleted. Reopening a finished ticket does not restore the old lease. Leases are runtime-only, so a restart cannot pin a ticket to a dead agent.

No open issue. Reclaim is already what the store and the guide do.

## Clear decomposition ownership (trees)

`parent` is the ownership edge. The parent owns the decomposition; each child is a piece of that split and takes its own lease. Progress rolls up to the parent. Cycles are rejected. Deleting a ticket promotes its children to its parent. A project (key `KEY`) groups tickets as `KEY-n`. It is not a node in the tree. `blockedBy` waits on another ticket; it does not transfer ownership.

Already true: parent links, rollups, cycle checks, and the lead versus pull policies in the guide.

Open work:

- [RIC-7](https://linear.app/richards-project-space/issue/RIC-7/task-tree-and-subtree-model-delm-style) — root-to-subtree reads, agent split and rewire, glanceable subtree counts. The board stays a coordination surface.
- [RIC-8](https://linear.app/richards-project-space/issue/RIC-8/convert-project-task-list-into-a-task-tree) — one-shot or incremental list-to-tree conversion that keeps ids and ownership and can be run again without duplicating work.
- [RIC-9](https://linear.app/richards-project-space/issue/RIC-9/multi-project-board-with-clear-ownership) — switch and filter across projects, with assignee and claimer visible, and the same filters on MCP.

## Supporting criteria

### The human stays in charge

Agent-authored command monitors and view modules wait for an explicit approval. Updates apply only after the person confirms. A failed save stays on screen. A local auth token exists for people who want one, and it stays off unless they turn it on.

- [RIC-16](https://linear.app/richards-project-space/issue/RIC-16/one-click-in-app-update-apply-still-user-approved) — download, verify, prompt, replace. No silent auto-update.
- [RIC-18](https://linear.app/richards-project-space/issue/RIC-18/confirm-before-run-ux-for-agent-authored-command-monitors) — a non-user command monitor waits for approval in Attention.
- [RIC-19](https://linear.app/richards-project-space/issue/RIC-19/trust-gate-for-installing-views-renderer-modules) — landed. An agent-written view lands only after a reviewed diff.
- [RIC-20](https://linear.app/richards-project-space/issue/RIC-20/surface-saveerror-recoveredfrom-loudly-in-app-chrome) — `saveError` or `recoveredFrom` keeps a banner up, with the data directory and restore.
- [RIC-21](https://linear.app/richards-project-space/issue/RIC-21/optional-local-auth-token-for-httpmcp-clients) — optional per-install token on HTTP and MCP. Default off.

### One contract

A feature lands on HTTP, the CLI and MCP together, and the guide names it. Humans get a short path; agents keep GUIDE.

- [RIC-10](https://linear.app/richards-project-space/issue/RIC-10/complete-mcp-surface-for-trees-projects-claims) — tool matrix, CLI and HTTP parity, smoke for projects, trees, claims, context and status.
- [RIC-22](https://linear.app/richards-project-space/issue/RIC-22/post-upgrade-mcp-reconnect-helper) — after an update, a one-shot reconnect checklist for clients still on the old process.
- [RIC-24](https://linear.app/richards-project-space/issue/RIC-24/expand-mcp-install-targets-beyond-claudecodexopencode) — another client at install/status parity, or a tested generic profile.
- [RIC-25](https://linear.app/richards-project-space/issue/RIC-25/machine-readable-guide-slices-for-tools) — `hud guide --section` and `/api/guide?section=` return one TOC slice.
- [RIC-35](https://linear.app/richards-project-space/issue/RIC-35/split-human-quickstart-from-agent-guide) — a human quickstart on the README; GUIDE stays the agent contract.
- [RIC-36](https://linear.app/richards-project-space/issue/RIC-36/align-version-mentions-across-readmeguidereleases) — landed. README and GUIDE name the latest stable release and keep the 0.1.0 / 0.1.1 history gates. They do not pin a download tag. This issue does not publish.
- [RIC-37](https://linear.app/richards-project-space/issue/RIC-37/contributor-change-surfaces-checklist-in-agentsmd) — landed. The route → client → MCP → CLI → GUIDE checklist is in AGENTS.md.

### A person can read the board

The same state the agents use is glanceable: canvas, attention, context, tickets and monitors.

- [RIC-11](https://linear.app/richards-project-space/issue/RIC-11/dark-mode-smooth-desktop-ui-leave-terminal-look) — landed. The board is a dark desktop UI ([STYLE.md](STYLE.md)). Light mode stays deferred.
- [RIC-23](https://linear.app/richards-project-space/issue/RIC-23/first-run-sample-board-for-agents-humans) — a first-run sample project, run, and monitors so `hud_overview` is useful immediately.
- [RIC-26](https://linear.app/richards-project-space/issue/RIC-26/scale-or-letterbox-the-1600900-board-to-window-size) — letterbox the fixed 1600×900 layout to the window.
- [RIC-27](https://linear.app/richards-project-space/issue/RIC-27/attention-inbox-polish-bulk-snoozeack-keyboard) — bulk ack, snooze and review from the keyboard.
- [RIC-28](https://linear.app/richards-project-space/issue/RIC-28/human-friendly-shared-context-timeline-in-inspector) — landed. The inspector shows a FACT/FAIL/SUMMARY timeline with a handoff copy.
- [RIC-29](https://linear.app/richards-project-space/issue/RIC-29/saved-ticket-filters-views-assignee-run-overdue) — a few named ticket filters in the UI and the CLI.
- [RIC-30](https://linear.app/richards-project-space/issue/RIC-30/ticket-git-branch-status-hint-local) — a read-only local hint that the ticket's branch exists or is checked out.
- [RIC-31](https://linear.app/richards-project-space/issue/RIC-31/built-in-monitor-templates-gallery) — landed. Disk, TLS, loopback HTTP, and cron-heartbeat templates (`hud add monitor --template`) ship with safe defaults.
- [RIC-32](https://linear.app/richards-project-space/issue/RIC-32/alert-routing-desktop-notification-optional-webhook) — desktop notifications, plus an optional webhook for severity-up events.
- [RIC-34](https://linear.app/richards-project-space/issue/RIC-34/context-retention-and-export-for-finished-runs) — landed. A finished or canceled run exports its context and attachments (`hud context export`).

### Install and keep the app

The packaged app is the board people run. Signing, the Linux agent path and the release train are how it stays that way. Publishing a release stays a human step.

- [RIC-14](https://linear.app/richards-project-space/issue/RIC-14/notarize-code-sign-macos-and-windows-installers) — Developer ID plus notarization on macOS, Authenticode on Windows.
- [RIC-15](https://linear.app/richards-project-space/issue/RIC-15/ship-appimage-cli-mcp-path-integration-or-document-deb-only) — landed. AppImage and `.deb` both install a stable `hud` command. Move the AppImage and run Install command again.
- [RIC-17](https://linear.app/richards-project-space/issue/RIC-17/publish-v013-or-next-stable-release-from-ci-draft) — landed. The four version fields agree at 0.2.0. A person pushing the tag `v0.2.0` lets CI create a draft. This issue does not tag or publish.

## Open issues

Snapshot 2026-10-27, updated for the squash-merges now on 0.2.0. Each issue maps to one criterion. Rows marked landed are already in this tree. [RIC-12](https://linear.app/richards-project-space/issue/RIC-12/rewrite-product-definition-for-board-as-coordination-trees) is this page. Syncing the three rules into the Linear project description is out of scope here. An issue that is not in the table has no criterion yet; add the row when it opens.

| Issue | Title | Criterion |
| --- | --- | --- |
| [RIC-7](https://linear.app/richards-project-space/issue/RIC-7/task-tree-and-subtree-model-delm-style) | Task tree and subtree model | Clear decomposition ownership (trees) |
| [RIC-8](https://linear.app/richards-project-space/issue/RIC-8/convert-project-task-list-into-a-task-tree) | Convert a task list into a task tree | Clear decomposition ownership (trees) |
| [RIC-9](https://linear.app/richards-project-space/issue/RIC-9/multi-project-board-with-clear-ownership) | Multi-project board with clear ownership | Clear decomposition ownership (trees) |
| [RIC-10](https://linear.app/richards-project-space/issue/RIC-10/complete-mcp-surface-for-trees-projects-claims) | MCP surface for trees, projects, claims | One contract |
| [RIC-11](https://linear.app/richards-project-space/issue/RIC-11/dark-mode-smooth-desktop-ui-leave-terminal-look) | Dark-mode desktop UI | A person can read the board (landed) |
| [RIC-12](https://linear.app/richards-project-space/issue/RIC-12/rewrite-product-definition-for-board-as-coordination-trees) | This product definition | In-repo contract |
| [RIC-13](https://linear.app/richards-project-space/issue/RIC-13/define-agent-coordination-playbooks-decentralized-vs-lead) | Coordination playbooks | Board-enforced leases (landed) |
| [RIC-14](https://linear.app/richards-project-space/issue/RIC-14/notarize-code-sign-macos-and-windows-installers) | Notarize and code-sign installers | Install and keep the app |
| [RIC-15](https://linear.app/richards-project-space/issue/RIC-15/ship-appimage-cli-mcp-path-integration-or-document-deb-only) | AppImage CLI / MCP path | Install and keep the app (landed) |
| [RIC-16](https://linear.app/richards-project-space/issue/RIC-16/one-click-in-app-update-apply-still-user-approved) | In-app update, user-approved | The human stays in charge |
| [RIC-17](https://linear.app/richards-project-space/issue/RIC-17/publish-v013-or-next-stable-release-from-ci-draft) | Prepare the 0.2.0 release train | Install and keep the app (landed) |
| [RIC-18](https://linear.app/richards-project-space/issue/RIC-18/confirm-before-run-ux-for-agent-authored-command-monitors) | Confirm agent command monitors | The human stays in charge |
| [RIC-19](https://linear.app/richards-project-space/issue/RIC-19/trust-gate-for-installing-views-renderer-modules) | Trust gate for view modules | The human stays in charge (landed) |
| [RIC-20](https://linear.app/richards-project-space/issue/RIC-20/surface-saveerror-recoveredfrom-loudly-in-app-chrome) | Loud save-error banner | The human stays in charge |
| [RIC-21](https://linear.app/richards-project-space/issue/RIC-21/optional-local-auth-token-for-httpmcp-clients) | Optional local auth token | The human stays in charge |
| [RIC-22](https://linear.app/richards-project-space/issue/RIC-22/post-upgrade-mcp-reconnect-helper) | Post-upgrade MCP reconnect | One contract |
| [RIC-23](https://linear.app/richards-project-space/issue/RIC-23/first-run-sample-board-for-agents-humans) | First-run sample board | A person can read the board |
| [RIC-24](https://linear.app/richards-project-space/issue/RIC-24/expand-mcp-install-targets-beyond-claudecodexopencode) | More MCP install targets | One contract |
| [RIC-25](https://linear.app/richards-project-space/issue/RIC-25/machine-readable-guide-slices-for-tools) | Guide slices for tools | One contract |
| [RIC-26](https://linear.app/richards-project-space/issue/RIC-26/scale-or-letterbox-the-1600900-board-to-window-size) | Letterbox the 1600×900 board | A person can read the board |
| [RIC-27](https://linear.app/richards-project-space/issue/RIC-27/attention-inbox-polish-bulk-snoozeack-keyboard) | Attention bulk actions | A person can read the board |
| [RIC-28](https://linear.app/richards-project-space/issue/RIC-28/human-friendly-shared-context-timeline-in-inspector) | Shared-context timeline | A person can read the board (landed) |
| [RIC-29](https://linear.app/richards-project-space/issue/RIC-29/saved-ticket-filters-views-assignee-run-overdue) | Saved ticket filters | A person can read the board |
| [RIC-30](https://linear.app/richards-project-space/issue/RIC-30/ticket-git-branch-status-hint-local) | Local git branch hint | A person can read the board |
| [RIC-31](https://linear.app/richards-project-space/issue/RIC-31/built-in-monitor-templates-gallery) | Monitor templates | A person can read the board (landed) |
| [RIC-32](https://linear.app/richards-project-space/issue/RIC-32/alert-routing-desktop-notification-optional-webhook) | Alert routing | A person can read the board |
| [RIC-33](https://linear.app/richards-project-space/issue/RIC-33/claimqueue-visibility-on-the-board-canvas) | Claim and queue visibility | Board-enforced leases (landed) |
| [RIC-34](https://linear.app/richards-project-space/issue/RIC-34/context-retention-and-export-for-finished-runs) | Export a finished run | A person can read the board (landed) |
| [RIC-35](https://linear.app/richards-project-space/issue/RIC-35/split-human-quickstart-from-agent-guide) | Human quickstart | One contract |
| [RIC-36](https://linear.app/richards-project-space/issue/RIC-36/align-version-mentions-across-readmeguidereleases) | Version mentions | One contract (landed) |
| [RIC-37](https://linear.app/richards-project-space/issue/RIC-37/contributor-change-surfaces-checklist-in-agentsmd) | Change-surface checklist | One contract (landed) |
