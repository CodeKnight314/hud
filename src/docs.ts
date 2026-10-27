import { asset } from './assets.ts';

/** Repo file on the release line. It is packaged with views/ but has no HTTP route. */
const VIEWS_README_URL = 'https://github.com/CodeKnight314/hud/blob/0.2.0/views/README.md';
/** Product contract. Packaged beside the guide; the served page has no directory for a relative link. */
const PRODUCT_URL = 'https://github.com/CodeKnight314/hud/blob/0.2.0/PRODUCT.md';
/**
 * Repo markdown keeps relative links so GitHub can open the sibling file.
 * The served copy points at the localhost route, because `/api/guide` has no directory.
 */
function serveDocLink(markdown: string, file: string, url: string): string {
  return markdown.replaceAll(`](./${file}`, `](${url}`).replaceAll(`](${file}`, `](${url}`);
}

/** Agent contract plus the visual contract. Relative quickstart links become GET /api/quickstart. */
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
