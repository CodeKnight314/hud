# Coordination playbooks

Follow one playbook. Fetch it on its own, then do what it says:

    hud guide decentralized
    hud guide lead
    hud_guide {playbook: "decentralized"}
    GET /api/guide?playbook=lead

`centralized` is the same playbook as `lead`. `hud guide playbooks` prints this page only.

Decentralized: every agent pulls ready work. There is no planner.
Lead: one agent creates the run, the links and the assignees. Everyone else runs the worker loop in that playbook.

A lead FACT is stored on `run:<uuid>`, so a read of `board:main` does not show it. A live lead is an open ticket tagged `run` (`backlog`, `todo`, `doing`, `review`, or `blocked`). Look first:

    hud_tickets {tag: "run", status: "backlog,todo,doing,review,blocked"}
    hud_context {action: "scopes"}

    hud tickets --tag run --status backlog,todo,doing,review,blocked
    hud context scopes

Then `hud_get` / `hud show` a ticket from that open list and read `run:` plus its `id` (a uuid, for example `run:3f2a9c1e-7b4d-4e8a-9c21-0b6d5e4a1f80`). A FACT there, or an empty read of that open ticket, means follow `hud guide lead`. A `done` or `canceled` run keeps its `run` tag, and `scopes` still lists that `run:<uuid>`. Neither is a live lead. Follow `hud guide decentralized` when the open list is empty. Both playbooks start with the same lookup.

Each playbook is claim, publish a FACT, wait, finish. The same page covers an expired lease, a blocked ticket, and an assignee conflict.

<!-- playbook:decentralized -->

## Decentralized

Every agent pulls from the same queue. Run the four steps in order. Recovery for an expired lease, a blocked ticket, and an assignee conflict is at the bottom of this playbook.

Your actor is `HUD_ACTOR`, or the MCP client name (`claude`, `codex`, `cursor`, and so on). MCP registers your session on connect and heartbeats every 20 seconds, which renews a lease. On the CLI, renew with `hud session heartbeat` or by claiming the same ticket again. One session holds one unfinished claim.

A lead FACT lives on `run:<uuid>` (the run ticket's `id` from `hud_get`). Reading `board:main` does not return it. Do step 0 before you claim. When step 0 finds no open run, publish on `board:<board id>` from the queue header (`board:main` on the default board). Claim, wait, link and finish take a `KEY-n` ident such as `EGO-3`.

### 0. Read a lead FACT

```
hud_tickets {tag: "run", status: "backlog,todo,doing,review,blocked"}
hud_context {action: "scopes"}
hud_get {id: "EGO-1"}
hud_context {action: "read", scope: "run:3f2a9c1e-7b4d-4e8a-9c21-0b6d5e4a1f80"}
```

```
hud tickets --tag run --status backlog,todo,doing,review,blocked
hud context scopes
hud show EGO-1
hud context read --scope run:3f2a9c1e-7b4d-4e8a-9c21-0b6d5e4a1f80
```

The status filter is the open list. It finds the run ticket before the first publish. `hud_get` / `hud show` returns its `id` and `status`. Read `run:` plus that uuid. The uuid in the example is the shape of `id`. `scopes` prints every scope that already has entries, including a finished run.

A FACT on an open run's scope means a lead is running this board. Stop this playbook and follow `hud guide lead` from the worker loop, on that same scope. An empty read of an open ticket tagged `run` means the same: join the lead playbook and publish on `run:<uuid>`.

A `done` or `canceled` run keeps its `run` tag, and `scopes` still lists that `run:<uuid>`. Neither is a live lead. Follow `hud guide decentralized` when the open list is empty. Continue at step 1 and use `board:main`.

### 1. Claim

```
hud_queue {}
hud_claim {ticket: "EGO-3", start: true}
```

```
hud queue
hud claim EGO-3 --start
```

Take the first ready row (open, unblocked, unclaimed) whose Owner is blank or your actor. In the queue JSON that field is `assignee`. `start: true` moves the ticket to `doing`. The lease is 120 seconds. Pass `ttl` between 15 and 900 to change it. Claim the same ticket again to renew.

### 2. Publish a FACT

Read the scope, then publish what you measured: the inputs, the result, and what is still unverified.

```
hud_context {action: "read", scope: "board:main"}
hud_context {action: "publish", scope: "board:main", kind: "FACT", text: "trailing commas parse on tests/parse.json; quoted commas not rechecked", refs: ["EGO-3"]}
```

```
hud context read --scope board:main
hud context publish --scope board:main --kind FACT --text "trailing commas parse on tests/parse.json; quoted commas not rechecked" --refs EGO-3
```

A contradicted approach is `kind: "FAIL"`, with the conditions under which it failed. A FACT or FAIL is the record a peer uses. Keep it under 4 KB. The read returns `cursor`. Hold that number for the wait.

### 3. Wait

Wait when the next step depends on a peer's entry, a claim coming free, or a ticket changing. When nothing you need is outstanding, go to finish.

```
hud_wait {scope: "board:main", since: 14, timeoutSeconds: 20}
```

```
hud wait --scope board:main --since 14 --timeout 20
```

`since` is the `cursor` from your read, so an entry that landed after the read still wakes you. Your own publish stays quiet. A response of `no matching event within 20s` means you read again and wait again with the new cursor. To watch one ticket (a blocker finished, a claim released):

```
hud_wait {ticket: "EGO-3", timeoutSeconds: 20}
```

### 4. Finish

Publish the outcome, then finish. Finish releases the lease.

```
hud_context {action: "publish", scope: "board:main", kind: "SUMMARY", text: "EGO-3 done: trailing commas kept; quoted commas still open", refs: ["EGO-3"]}
hud_finish {ids: ["EGO-3"], note: "done", organize: false}
```

```
hud context publish --scope board:main --kind SUMMARY --text "EGO-3 done: trailing commas kept; quoted commas still open" --refs EGO-3
hud finish EGO-3 --note "done" --no-organize
```

`organize: false` leaves the shared board layout alone. Stopping before the ticket is done:

```
hud_claim {action: "release", ticket: "EGO-3"}
```

```
hud release EGO-3
```

### Expired lease

A lease lasts 120 seconds. MCP's 20 second heartbeat renews it while the session is live. A session with no heartbeat for 90 seconds ends, and its claims are released. A restart drops every claim. On the CLI, `hud session heartbeat` or another `hud claim EGO-3` is the renewal.

After a pause, read the lease before you write:

```
hud_claim {action: "status", ticket: "EGO-3"}
```

- The ticket is free: claim it again with `start: true`. Another agent may have taken it.
- A live peer holds it. The error is 409 `claimed`. Claim a different ready row. A live lease stays with its holder.
- The holder is gone and the error is 409 `claimed` with `stale: true`. Retry once:

```
hud_claim {ticket: "EGO-3", start: true, takeover: true}
```

```
hud claim EGO-3 --start --takeover
```

- Your session has ended (409 `session-ended`): `hud_session {action: "start"}`, then claim again.

### Blocked ticket

`start: true` on a blocked ticket returns 409 `blocked` and does not take the lease. The queue row lists the open blockers under Blocked by.

Wait for the blocker, then claim:

```
hud_wait {ticket: "EGO-2", timeoutSeconds: 20}
hud_claim {ticket: "EGO-3", start: true}
```

Or claim a different ready row. Record a dependency so the ticket clears itself when the blocker finishes:

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

Your actor is `HUD_ACTOR`, or the MCP client name. MCP heartbeats every 20 seconds and renews your lease. On the CLI, renew with `hud session heartbeat`. One session holds one unfinished claim.

A context scope uses the `id` field from `hud_get`. Claim, wait, link and finish take the `KEY-n` ident.

### Lead loop

#### 1. Claim

Create the project and a ticket tagged `run`, read its `id`, then claim that ticket so a second agent becomes a worker.

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

When the children are done, publish the run outcome and finish the run ticket. Finish releases the lead's claim.

```
hud_context {action: "publish", scope: "run:<uuid>", kind: "SUMMARY", text: "EGO-1 done: trailing commas kept; EGO-2 and EGO-3 closed", refs: ["EGO-1"]}
hud_finish {ids: ["EGO-1"], note: "run complete", organize: false}
```

```
hud context publish --scope run:<uuid> --kind SUMMARY --text "EGO-1 done: trailing commas kept; EGO-2 and EGO-3 closed" --refs EGO-1
hud finish EGO-1 --note "run complete" --no-organize
```

Finishing the run ticket is what makes the open list empty, so the next joiner follows `hud guide decentralized`. The `run` tag and the scope log stay.

### Worker loop

The failure modes below are part of this loop. Start by reading the lead FACT. It is not on `board:main`.

#### 0. Read the lead FACT

```
hud_tickets {tag: "run", status: "backlog,todo,doing,review,blocked"}
hud_context {action: "scopes"}
hud_get {id: "EGO-1"}
hud_context {action: "read", scope: "run:3f2a9c1e-7b4d-4e8a-9c21-0b6d5e4a1f80"}
```

```
hud tickets --tag run --status backlog,todo,doing,review,blocked
hud context scopes
hud show EGO-1
hud context read --scope run:3f2a9c1e-7b4d-4e8a-9c21-0b6d5e4a1f80
```

`EGO-1` is the ident from the open list. The scope is `run:` plus the `id` uuid from `hud_get` / `hud show`. Copy the scope string from the lead FACT when the text names one. Every later read and publish in this loop uses that scope. A `done` or `canceled` run keeps its `run` tag, and `scopes` still lists that `run:<uuid>`. Neither is a live lead. Follow `hud guide decentralized` when the open list is empty.

#### 1. Claim

```
hud_queue {project: "EGO"}
hud_claim {ticket: "EGO-2", start: true}
```

```
hud queue --project EGO
hud claim EGO-2 --start
```

Take a ready row whose Owner is blank or your actor. Leave rows owned by someone else, and leave blocked rows until they are ready.

#### 2. Publish a FACT

```
hud_context {action: "read", scope: "run:<uuid>"}
hud_context {action: "publish", scope: "run:<uuid>", kind: "FACT", text: "EGO-2: trailing commas parse on tests/parse.json; quoted commas not rechecked", refs: ["EGO-2"]}
```

```
hud context read --scope run:<uuid>
hud context publish --scope run:<uuid> --kind FACT --text "EGO-2: trailing commas parse on tests/parse.json; quoted commas not rechecked" --refs EGO-2
```

A contradicted approach is `kind: "FAIL"` with the conditions. Hold the read's `cursor`.

#### 3. Wait

Wait when you need a peer's entry or a blocker to finish. When the ticket is otherwise ready to close, go to finish.

```
hud_wait {scope: "run:<uuid>", since: 14, timeoutSeconds: 20}
```

```
hud wait --scope run:<uuid> --since 14 --timeout 20
```

`no matching event within 20s`: read again, then wait with the new cursor. To watch the blocker itself, `hud_wait {ticket: "EGO-2", timeoutSeconds: 20}`.

#### 4. Finish

```
hud_context {action: "publish", scope: "run:<uuid>", kind: "SUMMARY", text: "EGO-2 done: trailing commas kept; quoted commas still open", refs: ["EGO-2"]}
hud_finish {ids: ["EGO-2"], note: "done", organize: false}
```

```
hud context publish --scope run:<uuid> --kind SUMMARY --text "EGO-2 done: trailing commas kept; quoted commas still open" --refs EGO-2
hud finish EGO-2 --note "done" --no-organize
```

Finish releases the claim. Stopping earlier:

```
hud_claim {action: "release", ticket: "EGO-2"}
```

### Expired lease

A lease lasts 120 seconds. The MCP heartbeat renews it. A session with no heartbeat for 90 seconds ends and its claims release. A restart drops them. CLI work renews with `hud session heartbeat` or another claim of the same ticket.

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
