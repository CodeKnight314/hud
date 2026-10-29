# Coordination playbooks

Follow one playbook. Fetch it on its own, then do what it says:

    hud guide decentralized
    hud guide lead
    hud_guide {playbook: "decentralized"}
    GET /api/guide?playbook=lead

`centralized` is the same playbook as `lead`. `hud guide playbooks` prints this page only.

Decentralized: every agent pulls ready work. Any agent may split a ticket into children. There is no planner.
Lead: one agent creates the run, the links and the assignees. Everyone else runs the worker loop in that playbook.

Which playbook: decentralized suits 2-3 agents on one task where any agent may split work. Lead suits work one agent should split and integrate. DeLM (arXiv 2606.10662), the model for both, measured its gains with 2 agents and saw a small accuracy drop at 4.

Look first. The queue header names any live lead: an open ticket tagged `run` whose claim is held by a live session.

    hud_queue {}
    hud queue

A lead means follow `hud guide lead` (the worker loop) on its scope. No lead means follow `hud guide decentralized`. A `run` ticket with no live claim is not a lead. It may be a training-run summary, or a lead that died.

Each playbook is claim, publish a FACT, wait, finish. The same page covers a lost lease, an expired lease, a blocked ticket, and an assignee conflict.

<!-- playbook:decentralized -->

## Decentralized

Every agent pulls from the same queue. Run the steps in order. Recovery for a lost or expired lease, a blocked ticket, and an assignee conflict is at the bottom of this playbook.

Your actor is `HUD_ACTOR`, or the MCP client name (`claude`, `codex`, `cursor`, and so on). MCP registers your session on connect and heartbeats every 20 seconds. A lease stops renewing after 15 minutes without hud calls, so publish, claim or read within that. On the CLI, run `hud session heartbeat` or claim the same ticket again at least every 60 seconds; any other hud command keeps the session present but does not extend the lease. Under Claude Code with hud's MCP connected, the CLI shares that MCP session, so its heartbeat renews the lease. One session holds one unfinished claim.

Publish on `board:<board id>` from the queue header (`board:main` on the default board). Claim, wait, link and finish take a `KEY-n` ident such as `EGO-3`.

### 0. Queue

```
hud_queue {}
```

```
hud queue
```

The first lines name the lead, or say there is none. A live lead: stop this playbook and follow `hud guide lead` from the worker loop, on that scope. No live lead: continue. A `run` ticket with no live claim is not a lead.

### 1. Read before you choose

Read the scope and its open FAILs, so you skip dead ends.

```
hud_context {action: "read", scope: "board:main"}
hud_context {action: "read", scope: "board:main", open: true}
```

```
hud context read --scope board:main
hud context read --scope board:main --open
```

A FAIL stays open until a later entry corrects it. The read returns `cursor`. Hold that number for the wait.

### 2. Claim

```
hud_claim {ticket: "EGO-3", start: true}
```

```
hud claim EGO-3 --start
```

Take the first ready row whose Owner is blank or your actor. In the queue JSON that field is `assignee`. A parent with open children is not ready. `start: true` moves the ticket to `doing`. The lease is 120 seconds and the holder renews it. Pass `ttl` between 15 and 900 to change it. Claim the same ticket again to renew.

### 3. Worktree

A claim stops two agents taking the same ticket. It does not stop them editing the same files. Work in your own git worktree. Claim the ticket again with the flag, or add it to the claim in step 2:

```
hud_claim {ticket: "EGO-3", worktree: true}
```

```
hud claim EGO-3 --worktree
```

hud runs git in your process, not on the server. It creates `../<repo>-ego-3` on the ticket's `branch` (from `hud_get`), reuses it on a later claim, and prints `cd <path>`. MCP uses the directory its client started in. The CLI uses your shell's, so run it from the main checkout. A git failure is reported and the claim stands. By hand, from the repo root: `git worktree add ../<repo>-ego-3 -b <branch>`.

Work and commit there. Name the branch in your SUMMARY. The agent that runs the parent's whole-task check merges the children's branches.

An MCP client's subagents share its session, so they cannot each hold a claim. Each agent is its own top-level session with its own worktree.

### 4. Announce

Publish a STATUS that refs the ticket and says what you are attempting. Peers see it in the queue Note column.

```
hud_context {action: "publish", scope: "board:main", kind: "STATUS", text: "EGO-3: checking trailing commas in tests/parse.json", refs: ["EGO-3"]}
```

```
hud context publish --scope board:main --kind STATUS --text "EGO-3: checking trailing commas in tests/parse.json" --refs EGO-3
```

### 5. Split when the ticket is more than one agent's work

Create children with `parent` set to the ticket, unassigned, with `blockedBy` where order matters. Publish a FACT naming them, release the parent, and claim one child.

```
hud_create {type: "ticket", title: "Parse trailing commas", project: "EGO", parent: "EGO-3"}
hud_create {type: "ticket", title: "Parse quoted commas", project: "EGO", parent: "EGO-3", blockedBy: ["EGO-4"]}
hud_context {action: "publish", scope: "board:main", kind: "FACT", text: "EGO-3 split into EGO-4 (trailing commas) and EGO-5 (quoted commas, after EGO-4)", refs: ["EGO-3", "EGO-4", "EGO-5"]}
hud_claim {action: "release", ticket: "EGO-3"}
hud_claim {ticket: "EGO-4", start: true, worktree: true}
```

```
hud add ticket "Parse trailing commas" --project EGO
hud link EGO-4 parent=EGO-3
hud add ticket "Parse quoted commas" --project EGO
hud link EGO-5 parent=EGO-3 blockedBy=EGO-4
hud context publish --scope board:main --kind FACT --text "EGO-3 split into EGO-4 (trailing commas) and EGO-5 (quoted commas, after EGO-4)" --refs EGO-3,EGO-4,EGO-5
hud release EGO-3
hud claim EGO-4 --start --worktree
```

Add a ticket only for required implementation, the repair of a demonstrated defect, or a concrete open question.

Nest by deliverable:

- A child is part of its parent's deliverable. Order between tickets is `blockedBy`.
- Keep at most 7 children per parent. Beyond that, group them under a ticket whose check is a real decision, for example "pick the tracks to advance".
- A ticket that waits on most of its siblings integrates them. Make it their parent: `hud_link {id: "<sibling>", parent: "<integrator>"}`, `hud link <sibling> parent=<integrator>`.
- Create later-phase tickets when the earlier phase reports, not up front.
- Run lint after splitting. It warns `wide-parent` and `integration-sibling`.

```
hud_lint {board: "main"}
```

```
hud lint main
```

### 6. Work and share early

Publish a FACT as soon as you have measured something: the inputs, the result, and what is still unverified. Publish a FAIL as soon as an approach is contradicted, with the conditions. Publish a STATUS when you switch hypothesis. Read the scope delta before each new subproblem.

```
hud_context {action: "publish", scope: "board:main", kind: "FACT", text: "trailing commas parse on tests/parse.json; quoted commas not rechecked", refs: ["EGO-4"]}
hud_context {action: "publish", scope: "board:main", kind: "FAIL", text: "regex split fails on quoted commas in tests/parse.json", refs: ["EGO-4"]}
hud_context {action: "read", scope: "board:main", since: 14}
```

```
hud context publish --scope board:main --kind FACT --text "trailing commas parse on tests/parse.json; quoted commas not rechecked" --refs EGO-4
hud context publish --scope board:main --kind FAIL --text "regex split fails on quoted commas in tests/parse.json" --refs EGO-4
hud context read --scope board:main --since 14
```

A FACT or FAIL is the record a peer uses. Keep it under 4 KB. A lease stops renewing after 15 minutes without hud calls, so publish or renew within that.

### 7. Wait only after independent work

When you need a peer's result, do the work that does not depend on it first. Then wait, bounded, with the cursor.

```
hud_wait {scope: "board:main", since: 14, timeoutSeconds: 20}
```

```
hud wait --scope board:main --since 14 --timeout 20
```

`since` is the `cursor` from your read, so an entry that landed after the read still wakes you. Your own publish stays quiet. A response of `no matching event within 20s` means you read again and wait again with the new cursor. To watch one ticket (a blocker finished, a claim released):

```
hud_wait {ticket: "EGO-4", timeoutSeconds: 20}
```

If the owner's session ends without finishing, build it yourself and reuse what they shared.

### 8. Finish

Read the open FAILs that ref your ticket. Fix each one, or publish an entry that `corrects` it and says why it no longer applies. Then publish a SUMMARY and finish. Finish releases the lease.

```
hud_context {action: "read", scope: "board:main", open: true, ref: "EGO-4"}
hud_context {action: "publish", scope: "board:main", kind: "SUMMARY", text: "EGO-4 done on branch ego-4-parse-trailing-commas: trailing commas kept; quoted commas still open", refs: ["EGO-4"]}
hud_finish {ids: ["EGO-4"], note: "done", organize: false}
```

```
hud context read --scope board:main --open --ref EGO-4
hud context publish --scope board:main --kind SUMMARY --text "EGO-4 done on branch ego-4-parse-trailing-commas: trailing commas kept; quoted commas still open" --refs EGO-4
hud finish EGO-4 --note "done" --no-organize
```

`organize: false` leaves the shared board layout alone. Stopping before the ticket is done:

```
hud_claim {action: "release", ticket: "EGO-4"}
```

```
hud release EGO-4
```

### 9. Whole-task check

When a parent becomes ready (every child done), the agent that claims it checks the parent's full description against the children's SUMMARYs and open FAILs. It claims the parent with `worktree: true` and merges each child's branch, named in the child's SUMMARY, into the parent's worktree first. Then it finishes the parent, or adds a repair child.

```
hud_context {action: "read", scope: "board:main", open: true, ref: "EGO-3"}
```

```
hud context read --scope board:main --open --ref EGO-3
```

### Lost lease

An MCP `⚠ hud:` notice, or a 409 `claimed` when you change status, finish or delete, means the lease is no longer yours. Read it before you write:

```
hud_claim {action: "status", ticket: "EGO-4"}
```

```
hud claim status EGO-4
```

- The ticket is free: claim it again with `start: true`.
- A live peer holds it: leave it and claim a different ready row.

### Expired lease

A lease lasts 120 seconds and renews while the session is live and active. A session with no heartbeat for 90 seconds ends, and its claims are released. A session with no hud calls for 15 minutes stays present but its leases stop renewing and expire. After a server restart MCP re-takes your lease within about 20 seconds. Tickets that were in progress before the restart are held out of the ready list for 60 seconds.

CLI agents: under Claude Code the CLI session is `<actor>-<CLAUDE_PID>`, the same session as that agent's MCP. Otherwise it is derived from the parent process. Set `HUD_SESSION` to override.

- The ticket is free: claim it again with `start: true`.
- A live peer holds it (409 `claimed`): claim a different ready row.
- Takeover: 409 `claimed` with `stale: true` means the holder is gone. Retry once with takeover:

```
hud_claim {ticket: "EGO-4", start: true, takeover: true}
```

```
hud claim EGO-4 --start --takeover
```

- Your session has ended (409 `session-ended`): `hud_session {action: "start"}`, then claim again.

### Blocked ticket

`start: true` on a blocked ticket returns 409 `blocked` and does not take the lease. The queue row lists the open blockers under Blocked by.

Wait for the blocker, then claim, or claim a different ready row:

```
hud_wait {ticket: "EGO-2", timeoutSeconds: 20}
hud_claim {ticket: "EGO-3", start: true}
```

Record a dependency so the ticket clears itself when the blocker finishes:

```
hud_link {id: "EGO-3", blockedBy: ["EGO-2"]}
```

When a human has to choose, ask and stop. The ticket becomes blocked until they answer:

```
hud_ask {id: "EGO-3", question: "Ship with trailing commas kept?", options: [{label: "Keep them"}, {label: "Reject them"}]}
```

### Assignee conflict

409 `assigned` means the ticket's assignee is another actor. Leave it assigned to them and claim a ready row whose Owner is blank or your actor.

### One unfinished claim

409 `one-claim` names the ticket this session already holds. Finish that ticket, or `hud_claim {action: "release", ticket: "<ident>"}`, then claim the new one.

<!-- playbook:lead -->

## Lead

One agent is the lead. Everyone else is a worker. The lead claims the run, links the children, and publishes the scope. Workers pull. Run the loop that matches your role, then use the failure modes at the bottom. This page is the whole protocol for both roles.

Your actor is `HUD_ACTOR`, or the MCP client name. MCP heartbeats every 20 seconds. A lease stops renewing after 15 minutes without hud calls. On the CLI, run `hud session heartbeat` or claim the same ticket again at least every 60 seconds; any other hud command keeps the session present but does not extend the lease. Under Claude Code with hud's MCP connected, the CLI shares that MCP session, so its heartbeat renews the lease. One session holds one unfinished claim.

A context scope uses the `id` field from `hud_get`. Claim, wait, link and finish take the `KEY-n` ident.

### Lead loop

#### 1. Claim

Create the project and a ticket tagged `run`, read its `id`, then claim that ticket first. The queue then shows it as the live lead, and workers find it with `hud_queue`.

```
hud_project {action: "create", name: "Eng org", key: "EGO"}
hud_create {type: "ticket", title: "Ship the parser", project: "EGO", tags: ["run"]}
hud_get {id: "EGO-1"}
hud_claim {ticket: "EGO-1", start: true}
```

```
hud project new "Eng org" --key EGO
hud add ticket "Ship the parser" --project EGO --tags run
hud show EGO-1
hud claim EGO-1 --start
```

`hud_get` / `hud show` prints `id`, a uuid such as `3f2a9c1e-7b4d-4e8a-9c21-0b6d5e4a1f80`. The scope for every later entry is `run:<uuid>`. On a fresh project the idents are EGO-1, then EGO-2, then EGO-3. Use the ident each create call prints when the project already has tickets.

Add the children. `parent` groups them under the run. `blockedBy` is the dependency. `assignee` is the worker's actor, the same string hud records on their mutations.

```
hud_create {type: "ticket", title: "Parse trailing commas", project: "EGO", parent: "EGO-1"}
hud_create {type: "ticket", title: "Publish the grammar note", project: "EGO", parent: "EGO-1", blockedBy: ["EGO-2"], assignee: "claude"}
```

```
hud add ticket "Parse trailing commas" --project EGO
hud link EGO-2 parent=EGO-1
hud add ticket "Publish the grammar note" --project EGO --assignee claude
hud link EGO-3 parent=EGO-1 blockedBy=EGO-2
```

Leave a ticket with no fixed owner unassigned so any worker can pull it. The lead keeps the claim on the run ticket and leaves the children in the queue.

Nest by deliverable:

- A child is part of its parent's deliverable. Order between tickets is `blockedBy`.
- Keep at most 7 children per parent. Beyond that, group them under a ticket whose check is a real decision, for example "pick the tracks to advance".
- A ticket that waits on most of its siblings integrates them. Make it their parent: `hud_link {id: "<sibling>", parent: "<integrator>"}`, `hud link <sibling> parent=<integrator>`.
- Create later-phase tickets when the earlier phase reports, not up front.
- Run lint after splitting. It warns `wide-parent` and `integration-sibling`.

```
hud_lint {board: "main"}
```

```
hud lint main
```

#### 2. Publish a FACT

The FACT is the plan. Include the scope string, who owns what, and which tickets wait.

```
hud_context {action: "read", scope: "run:<uuid>"}
hud_context {action: "publish", scope: "run:<uuid>", kind: "FACT", text: "Lead is <actor>. Scope is run:<uuid>. EGO-2 parses trailing commas and is free to pull. EGO-3 is blocked by EGO-2 and assigned to claude.", refs: ["EGO-1", "EGO-2", "EGO-3"]}
```

```
hud context read --scope run:<uuid>
hud context publish --scope run:<uuid> --kind FACT --text "Lead is <actor>. Scope is run:<uuid>. EGO-2 is free to pull. EGO-3 is blocked by EGO-2 and assigned to claude." --refs EGO-1,EGO-2,EGO-3
```

Replace `<uuid>` with the run ticket's `id` from `hud_get` and `<actor>` with your actor. Workers copy that scope.

#### 3. Wait

Wait on the run scope for worker entries. `since` is the `cursor` from the read.

```
hud_wait {scope: "run:<uuid>", since: 14, timeoutSeconds: 20}
```

```
hud wait --scope run:<uuid> --since 14 --timeout 20
```

On `no matching event within 20s`, read again and wait with the new cursor. A worker's SUMMARY on their ticket means that child is done. A blocked row clears when its blocker finishes.

#### 4. Finish

When the children are done, publish the run outcome and finish the run ticket. Finish releases the lead's claim. The lead's finish includes the whole-task check. First merge each child's branch, named in its SUMMARY, into the run ticket's branch. Then read the open FAILs on the run scope and compare the children's SUMMARYs to the run ticket's description. Finish it, or add a repair child.

```
hud_context {action: "publish", scope: "run:<uuid>", kind: "SUMMARY", text: "EGO-1 done: trailing commas kept; EGO-2 and EGO-3 closed", refs: ["EGO-1"]}
hud_finish {ids: ["EGO-1"], note: "run complete", organize: false}
```

```
hud context publish --scope run:<uuid> --kind SUMMARY --text "EGO-1 done: trailing commas kept; EGO-2 and EGO-3 closed" --refs EGO-1
hud finish EGO-1 --note "run complete" --no-organize
```

Finishing the run ticket ends the lead, so the queue header stops naming it and the next joiner follows `hud guide decentralized`. The `run` tag and the scope log stay.

### Worker loop

The failure modes below are part of this loop. Start by reading the lead FACT. It is not on `board:main`.

#### 0. Find the lead

```
hud_queue {}
hud_context {action: "read", scope: "run:3f2a9c1e-7b4d-4e8a-9c21-0b6d5e4a1f80"}
hud_context {action: "read", scope: "run:3f2a9c1e-7b4d-4e8a-9c21-0b6d5e4a1f80", open: true}
```

```
hud queue
hud context read --scope run:3f2a9c1e-7b4d-4e8a-9c21-0b6d5e4a1f80
hud context read --scope run:3f2a9c1e-7b4d-4e8a-9c21-0b6d5e4a1f80 --open
```

The queue header names the live lead: an open `run` ticket whose claim is held by a live session, with its scope `run:<uuid>`. The uuid in the example is the shape of the ticket's `id`. Copy the scope from the header or the lead FACT. Every later read and publish in this loop uses that scope. Read the open FAILs so you skip dead ends. A `run` ticket with no live claim is not a lead. Follow `hud guide decentralized` when the header says there is no live lead.

#### 1. Claim

```
hud_queue {project: "EGO"}
hud_claim {ticket: "EGO-2", start: true}
```

```
hud queue --project EGO
hud claim EGO-2 --start
```

Take a ready row whose Owner is blank or your actor. A parent with open children is not ready. Leave rows owned by someone else, and leave blocked rows until they are ready.

#### 2. Worktree

A claim stops two workers taking the same ticket. It does not stop them editing the same files. Work in your own git worktree. Claim the ticket again with the flag, or add it to the claim in step 1:

```
hud_claim {ticket: "EGO-2", worktree: true}
```

```
hud claim EGO-2 --worktree
```

hud runs git in your process, not on the server. It creates `../<repo>-ego-2` on the ticket's `branch` (from `hud_get`), reuses it on a later claim, and prints `cd <path>`. MCP uses the directory its client started in. The CLI uses your shell's, so run it from the main checkout. A git failure is reported and the claim stands. By hand, from the repo root: `git worktree add ../<repo>-ego-2 -b <branch>`.

Work and commit there. Name the branch in your SUMMARY. The lead merges the children's branches.

An MCP client's subagents share its session, so they cannot each hold a claim. Each worker is its own top-level session with its own worktree.

#### 3. Publish a FACT

```
hud_context {action: "read", scope: "run:<uuid>"}
hud_context {action: "publish", scope: "run:<uuid>", kind: "FACT", text: "EGO-2: trailing commas parse on tests/parse.json; quoted commas not rechecked", refs: ["EGO-2"]}
```

```
hud context read --scope run:<uuid>
hud context publish --scope run:<uuid> --kind FACT --text "EGO-2: trailing commas parse on tests/parse.json; quoted commas not rechecked" --refs EGO-2
```

A contradicted approach is `kind: "FAIL"` with the conditions. Hold the read's `cursor`.

#### 4. Wait

Wait when you need a peer's entry or a blocker to finish. When the ticket is otherwise ready to close, go to finish.

```
hud_wait {scope: "run:<uuid>", since: 14, timeoutSeconds: 20}
```

```
hud wait --scope run:<uuid> --since 14 --timeout 20
```

`no matching event within 20s`: read again, then wait with the new cursor. To watch the blocker itself, `hud_wait {ticket: "EGO-2", timeoutSeconds: 20}`.

#### 5. Finish

Read the open FAILs that ref your ticket (`hud_context {action: "read", scope: "run:<uuid>", open: true, ref: "EGO-2"}`, `hud context read --scope run:<uuid> --open --ref EGO-2`). Fix each one, or publish an entry that `corrects` it and says why it no longer applies.

```
hud_context {action: "publish", scope: "run:<uuid>", kind: "SUMMARY", text: "EGO-2 done on branch ego-2-parse-trailing-commas: trailing commas kept; quoted commas still open", refs: ["EGO-2"]}
hud_finish {ids: ["EGO-2"], note: "done", organize: false}
```

```
hud context publish --scope run:<uuid> --kind SUMMARY --text "EGO-2 done on branch ego-2-parse-trailing-commas: trailing commas kept; quoted commas still open" --refs EGO-2
hud finish EGO-2 --note "done" --no-organize
```

Finish releases the claim. Stopping earlier:

```
hud_claim {action: "release", ticket: "EGO-2"}
```

### Expired lease

A lease lasts 120 seconds. The MCP heartbeat renews it while the session is active. A session with no heartbeat for 90 seconds ends and its claims release. A session with no hud calls for 15 minutes keeps presence but its leases expire. After a restart MCP re-takes your lease within about 20 seconds, and tickets in progress before the restart are held out of the ready list for 60 seconds. A `⚠ hud:` notice or a 409 `claimed` on a status change, finish or delete means the lease is lost. CLI work renews with `hud claim <ident>`; the CLI session is `<actor>-<CLAUDE_PID>` under Claude Code, or set `HUD_SESSION`.

```
hud_claim {action: "status", ticket: "EGO-2"}
```

- The ticket is free: claim it again with `start: true`.
- A live peer holds it (409 `claimed`). Leave it. The lead keeps the run claim; a worker claims a different ready row. A live lease stays with its holder.
- The holder is gone and the error is 409 `claimed` with `stale: true`. Retry once with `takeover: true` (`hud claim EGO-2 --start --takeover`). The lead uses this to recover a worker ticket whose session ended before the lease clock did. After the lease expires, an ordinary claim takes it.
- 409 `session-ended`: `hud_session {action: "start"}`, then claim again.

Changing `assignee` to someone else releases the current claim. The lead does that when a different actor should own the ticket:

```
hud_update {id: "EGO-3", assignee: "codex"}
```

### Blocked ticket

Workers claim ready rows. `start: true` on a blocked ticket returns 409 `blocked` and does not take the lease.

The lead expresses the wait with `blockedBy`, so the ticket returns to `todo` when the blocker finishes or is canceled. A worker waits, then claims:

```
hud_wait {ticket: "EGO-2", timeoutSeconds: 20}
hud_claim {ticket: "EGO-3", start: true}
```

Or the worker claims a different ready row. The lead leaves the blocked status in place until the dependency clears. A human decision goes through `hud_ask`, which blocks the ticket until they answer:

```
hud_ask {id: "EGO-3", question: "Ship with trailing commas kept?", options: [{label: "Keep them"}, {label: "Reject them"}]}
```

### Assignee conflict

409 `assigned` means this actor is not the assignee. A worker leaves the ticket and claims a ready row whose Owner is blank or their actor.

The lead set `assignee` to the worker's actor. To move ownership, the lead updates it (that also releases a claim):

```
hud_update {id: "EGO-3", assignee: "codex"}
```

```
hud set EGO-3 --assignee codex
```

### One unfinished claim

409 `one-claim` names the ticket this session already holds. Finish or release it, then claim the next one. The lead's single claim is the run ticket; the children's claims belong to workers.
