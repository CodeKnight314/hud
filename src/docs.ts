import { asset } from './assets.ts';

/**
 * The only served-doc builder. HTTP, CLI, and MCP call `guideText` / `quickstartText`.
 * Do not concatenate GUIDE.md and STYLE.md anywhere else: a second builder skips this
 * relative-link rewrite. Sibling drafts that grow their own full-guide body (`fullGuide`,
 * `renderGuide`) have to call `guideText` for that body. A GUIDE-only slice must not
 * point at the visual-contract anchor, because STYLE.md is not in the slice.
 */

/** Repo file on the release line. It is packaged with views/ but has no HTTP route. */
const VIEWS_README_URL = 'https://github.com/CodeKnight314/hud/blob/0.2.0/views/README.md';
/** Product contract. Packaged beside the guide; the served page has no directory for a relative link. */
const PRODUCT_URL = 'https://github.com/CodeKnight314/hud/blob/0.2.0/PRODUCT.md';
/**
 * Repo markdown keeps relative links so GitHub can open the sibling file.
 * The served copy has no directory, so each link becomes a URL or an in-page anchor.
 */
function serveDocLink(markdown: string, file: string, url: string): string {
  return markdown
    .replaceAll(`](./${file}#`, `](${url}#`)
    .replaceAll(`](./${file})`, `](${url})`)
    .replaceAll(`](${file}#`, `](${url}#`)
    .replaceAll(`](${file})`, `](${url})`);
}

function headingSlug(heading: string): string {
  return heading.toLowerCase().trim().replace(/[^\w\- ]+/g, '').replace(/\s+/g, '-');
}

/** Anchor of the visual contract once STYLE.md is appended to the served guide. */
function styleAnchor(style: string): string {
  const title = /^#\s+(.+)$/m.exec(style)?.[1]?.trim();
  return `#${title ? headingSlug(title) : 'hud-visual-contract'}`;
}

/** Agent contract plus the visual contract. */
export function guideText(port: number): string {
  const style = asset('STYLE.md', 'utf8') ?? '';
  const raw = `${asset('GUIDE.md', 'utf8') ?? ''}\n\n${style}`;
  return serveDocLink(
    serveDocLink(raw, 'QUICKSTART.md', `http://localhost:${port}/api/quickstart`),
    'PRODUCT.md',
    PRODUCT_URL,
  )
    .replaceAll('](./STYLE.md)', `](${styleAnchor(style)})`)
    .replaceAll('](STYLE.md)', `](${styleAnchor(style)})`)
    .replaceAll('](./views/README.md)', `](${VIEWS_README_URL})`)
    .replaceAll('](views/README.md)', `](${VIEWS_README_URL})`)
    .replaceAll('{{PORT}}', String(port));
}

/** Human quickstart. Relative guide links become GET /api/guide. */
export function quickstartText(port: number): string {
  const raw = asset('QUICKSTART.md', 'utf8') ?? '';
  return serveDocLink(raw, 'GUIDE.md', `http://localhost:${port}/api/guide`).replaceAll('{{PORT}}', String(port));
}
