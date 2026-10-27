# views/ — agent-authored chart renderers

A monitor can name a renderer module here instead of one of the built-in display kinds:

```
hud add monitor "gpu load" --display view:bullet
```

## The contract

An ES module exporting either `export function render(ctx)` or `export default function (ctx)` (`render` wins if both exist). `render` returns an
HTML string (or a DOM node). `ctx`:

| field | meaning |
|---|---|
| `item` | the monitor item, as the canvas sees it — `value`, `unit`, `label`, `history`, `meta`, thresholds, `state` |
| `w`, `h` | the box to draw into, in CSS pixels (already minus the card's header/footer) |
| `helpers` | shared primitives so your chart looks like the built-ins: `esc, fmt, clamp, shade, seriesOf, categoriesOf, pointsOf, gridOf, rangeOf, svg` |
| `hit(px, py, value, label)` | register a point for the hover readout |

Use `helpers.svg(item, cls, W, H, body, hits)` to get the standard monochrome SVG wrapper.

This contract is for trusted renderer modules installed in `views/`. For a data-bound program stored with a board,
use the isolated `hud_graph` or `hud_canvas` flow documented in [GUIDE.md](../GUIDE.md); those programs have their own
bindings, SDK and explicit capability grants. Do not treat a Markdown code block as executable code.

## Generating one

`hud_view` / `hud view` writes a module in this contract from a small spec:

```
hud_view {action: "generate", name: "latency-bar", spec: {kind: "bar", series: "categories", unit: "ms"}, write: true, display: "monitor-id"}
hud view generate latency-bar --spec '{"kind":"bar","series":"categories"}' --write --display monitor-id
```

Kinds: `bar`, `line`, `sparkline`, `gauge`, `bullet`, `scatter`, `heatmap`, `table`, `slo`. `validate` runs the static
checks below and a headless render against a fixture. Generated modules are ordinary modules: read them, edit them,
or replace them with `hud view set`.

`hud view set` and `hud_view {action:"write"}` do not install caller-supplied source. They return a unified diff and a
proposal id. The module lands only after `hud view approve <name> --proposal <id> --sha <sha256>` (or
`hud_view {action:"approve", proposalId, sha256}`) for that exact review. Approving on the same call that submits the
code does not install it. `hud_view` write does not stage a proposal when the diff is larger than the tool result, so
the approve recipe is not returned for source the agent did not see. A generated module (`generate` with `write: true`)
is produced by hud and can still be written directly.

Static checks reject dynamic imports, `require`, `eval`, `new Function`, network APIs (`fetch`, `XMLHttpRequest`,
`WebSocket`, `EventSource`), storage and cookies, `window.open`, parent/top frame access, `location`/`history`, direct
`/api/` calls, script/iframe/object/embed tags and inline event handlers. They are advisory gates, not a sandbox.

**Trust boundary:** these modules run unsandboxed in the board page with the page's own origin. Caller-supplied and
other remote modules stay untrusted until a person or agent approves the review diff. Read that diff before approving.
A view received from another agent should be inspected with `hud attach`/`hud view show` before it is staged.

## Rules

- **Monochrome charts.** Use fill/stroke opacity for emphasis. Cards reserve red for blocked/decision/error states and
  green for done/ok; renderer content should not add semantic colors.
- **Never throw.** A module that throws shows its error inside its own card, but you should still guard.
- **Size to `w`/`h`.** Cards resize; do not hard-code a canvas size.
- **No network, no imports from `src/`.** Modules run in the page.
- **Follow the HUD visual contract.** Include readable units and provenance, and avoid clipping or overlap; see
  [STYLE.md](../STYLE.md).

## Reloading

Modules are cached per page load and cache-busted by mtime from `GET /api/views`, so saving the file
and reloading the app is enough. `hud views` lists what the server can see.
