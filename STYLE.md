# HUD visual contract

HUD uses a monochrome, terminal-style interface. Keep dashboards readable at their rendered size, use compact labels,
and keep units and data provenance visible wherever a measurement appears. Prefer clear glyphs and words over color so
the board remains legible in text snapshots, grayscale and with color-vision differences.

## Palette and state

- Use black, white and gray for surfaces, text, borders, charts and ordinary states.
- Red (`--red`) marks a blocked ticket, a pending decision or a monitor in error.
- Green (`--green`) marks a done ticket or an `ok` monitor.
- A semantic color must always appear with a state glyph or label. Color never carries meaning by itself.
- Do not introduce other semantic colors. Use opacity, line style, shape and labels to distinguish chart series.

HUD's status vocabulary includes `●` for ok, `▲` for warning, `✕` for error, `○` for unknown, `◐` for running and `✓`
for done. A custom view can choose a suitable glyph, but it must also show the state label where ambiguity is possible.

## Layout and chart readability

- Keep card titles, values, units and freshness visible without clipping. Wrap long identifiers and let tables scroll
  horizontally when their columns cannot fit.
- Use a fixed, bounded board. Fit content into the available surface without overlaps; do not imply that two cards are
  related only because they happen to be adjacent.
- Keep metric identity, scope, unit and source close to its displayed value. Show `observedAt`, evidence and coverage
  where age or completeness affects interpretation; distinguish an estimated or partial value from a measured,
  complete value.
- Charts need readable axes, units, legends and target labels. Distinguish overlapping series with line patterns,
  markers or labels in addition to gray intensity. Event markers need their timestamp or short label.
- Use whitespace and text hierarchy instead of decorative color. Keep controls visibly labeled and make interactive
  points large enough to inspect.

## Custom code and reports

Markdown in notes, monitor reports and ordinary code fences is content, not a program. Code runs only when the user or
agent explicitly submits a `hud_graph` or `hud_canvas` program. Those programs use an isolated browser surface and the
provided SDK, with only declared data bindings and explicitly granted management capabilities. A preview or snapshot
is display-only and does not perform actions. Label every permitted action, identify its target, and display its result.

Filesystem `view:<name>` renderers are the separate trusted module mechanism described in [views/README.md](views/README.md).
They still follow this palette and readability contract.
