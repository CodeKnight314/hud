# HUD visual contract

HUD is a dark desktop app. Chrome, boards, inspectors and Settings share one layered surface, a sans-serif UI, and
short motion. Light mode is deferred: the app sets `color-scheme: dark` and does not offer a theme toggle.

Keep dashboards readable at their rendered size. Use compact labels, and keep units and data provenance visible
wherever a measurement appears. Prefer a glyph or word alongside color so the board stays legible in text snapshots,
grayscale and with color-vision differences.

## Surfaces

Tokens live on `:root` in `web/style.css`. Use the tokens; do not invent a second palette.

| Token | Role |
|---|---|
| `--bg` | Board canvas and page background |
| `--chrome` | Top bar, sidebar and status bar |
| `--panel` | Drawers, menus and popovers |
| `--card` | Cards and rows that sit on the canvas |
| `--raised` | Hover and pressed fills |
| `--inset` | Code, command input and other wells |
| `--fg` `--hi` `--dim` `--faint` | Primary, emphasis, secondary and quiet text. `--faint` stays at least 4.5:1 on `--card` and `--raised` |
| `--line` `--line2` | Hairline and stronger borders |
| `--accent` `--accent-dim` | Selection, focus and active chrome. Not a status |
| `--red` `--red-dim` | Blocked ticket, pending decision, or monitor error |
| `--yellow` `--yellow-dim` | Ticket in progress (`doing` or `review`) |
| `--green` `--green-dim` | Done ticket or `ok` / done monitor |
| `--font` `--font-mono` | UI sans-serif, and monospace for data |
| `--radius` `--shadow` `--shadow-pop` | Corners and elevation |

Surfaces step from `--bg` up through `--chrome`, `--panel` and `--card`. A selected control uses `--accent-dim`
with `--hi` text, or a 2px `--accent` focus ring. Do not invert a control to a light fill. Popovers use
`--shadow-pop`. Cards use a 10px radius and `--shadow`.

## Type

- UI chrome, tickets, notes and Settings use `--font`. Inter is preferred when it is installed; otherwise the system sans is used. Do not ship a webfont.
- Identifiers, measurements, code, the command line and chart labels use `--font-mono`.
- Section labels may be small and uppercase. Keep tracking tight. Do not set the whole UI in a monospace face.

## Status

- Red marks a blocked ticket, a pending decision or a monitor in error. Yellow marks a ticket in progress (`doing`
  or `review`). Green marks done or `ok`. A `todo` or `backlog` ticket stays gray.
- `--accent` is chrome only. It must not mean warning, progress or health. Progress meters use `--hi` on an `--inset` track.
- A status color always appears with a glyph or label. Color never carries meaning by itself.
- Show blocked, decision and error states as a tinted header or inset bar (`--red-dim` / `--green-dim`), not a
  solid banner of inverted text.
- Warning and stale stay neutral: the `▲` glyph, a stronger border, or a dimmed card. Do not add a fourth status hue.
- Chart series stay neutral (light strokes and opacity). Distinguish series with line pattern, markers or labels.

Status glyphs: `●` ok, `▲` warning, `✕` error, `○` unknown, `◐` running, `✓` done. A custom view may choose another
glyph, and must still show the state label where the glyph would be ambiguous.

## Motion and shape

- Corners are rounded. Borders are solid. The drag-select marquee is the one dashed rectangle.
- Hover, selection and border changes animate in about 140ms. Respect `prefers-reduced-motion`.
- Error glyphs may pulse. They must not blink in hard on/off steps.

## Layout and chart readability

- Keep card titles, values, units and freshness visible without clipping. Wrap long identifiers and let tables scroll
  horizontally when their columns cannot fit.
- Use a fixed, bounded board. Fit content into the available surface without overlaps; do not imply that two cards are
  related only because they happen to be adjacent.
- Keep metric identity, scope, unit and source close to its displayed value. Show `observedAt`, evidence and coverage
  where age or completeness affects interpretation; distinguish an estimated or partial value from a measured,
  complete value.
- Charts need readable axes, units, legends and target labels. Event markers need their timestamp or short label.
- Use whitespace and text hierarchy. Keep controls labeled, and make interactive points large enough to inspect.

## Custom code and reports

Markdown in notes, monitor reports and ordinary code fences is content, not a program. Code runs only when the user or
agent explicitly submits a `hud_graph` or `hud_canvas` program. Those programs use an isolated browser surface and the
provided SDK, with only declared data bindings and explicitly granted management capabilities. A preview or snapshot
is display-only and does not perform actions. Label every permitted action, identify its target, and display its result.

Sandboxed programs inherit this palette through `hud.theme` (`background`, `foreground`, `muted`, `accent`, `red`,
`green`, `font`). Match it instead of a black terminal page.

Filesystem `view:<name>` renderers are the separate trusted module mechanism described in [views/README.md](views/README.md).
They still follow this palette and readability contract.
