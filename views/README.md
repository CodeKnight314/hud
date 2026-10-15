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

## Rules

- **Monochrome.** The canvas has no colour: use fill/stroke opacity for emphasis. The only colours on
  screen are the two semantic states (red = needs attention, green = done), applied by the card itself.
- **Never throw.** A module that throws shows its error inside its own card, but you should still guard.
- **Size to `w`/`h`.** Cards resize; do not hard-code a canvas size.
- **No network, no imports from `src/`.** Modules run in the page.

## Reloading

Modules are cached per page load and cache-busted by mtime from `GET /api/views`, so saving the file
and reloading the app is enough. `hud views` lists what the server can see.
