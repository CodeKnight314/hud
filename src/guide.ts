import { asset } from './assets.ts';
import { guideText } from './docs.ts';

/**
 * One guide document, two optional filters.
 * `section` is a GUIDE.md table-of-contents anchor (`coordination`, `monitors`, …).
 * `playbook` is a coordination runbook (`decentralized`, `lead`) from PLAYBOOKS.md.
 * They are mutually exclusive. Neither one means the full guide (GUIDE.md plus STYLE.md).
 * A section runs from that heading through the line before the next TOC heading, so an
 * h2 that is not in the table of contents stays inside the previous TOC slice. STYLE.md
 * is appended only to the full guide. Every served guide body is `guideText`. A slice is
 * the GUIDE half of that text; an anchor that exists only in STYLE points at `/api/guide#…`.
 */

/** GitHub-style heading anchor: punctuation dropped, spaces become hyphens. */
export function headingSlug(heading: string): string {
  return heading.toLowerCase().trim().replace(/[^\w\- ]+/g, '').replace(/\s+/g, '-');
}

export type GuideSection = {
  anchor: string;
  title: string;
  level: number;
  markdown: string;
};

export type GuideTocEntry = { anchor: string; label: string };

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING = /^(#{2,6})[ \t]+(.+?)[ \t]*$/;

/** Headings outside fenced code, each running until the next heading of the same or higher level. */
export function parseGuide(markdown: string): GuideSection[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const heads: { level: number; title: string; line: number }[] = [];
  let fence: { char: string; size: number } | undefined;
  for (let i = 0; i < lines.length; i++) {
    const fenceLine = FENCE.exec(lines[i]);
    if (fenceLine) {
      const token = fenceLine[1];
      const rest = fenceLine[2];
      if (!fence) {
        fence = { char: token[0], size: token.length };
        continue;
      }
      if (token[0] === fence.char && token.length >= fence.size && rest.trim() === '') {
        fence = undefined;
        continue;
      }
    }
    if (fence) continue;
    const heading = HEADING.exec(lines[i]);
    if (!heading) continue;
    const title = heading[2].replace(/\s+#+\s*$/, '').trim();
    if (!title) continue;
    heads.push({ level: heading[1].length, title, line: i });
  }
  return heads.map((head, i) => {
    let end = lines.length;
    for (let j = i + 1; j < heads.length; j++) {
      if (heads[j].level <= head.level) {
        end = heads[j].line;
        break;
      }
    }
    return { anchor: headingSlug(head.title), title: head.title, level: head.level, markdown: lines.slice(head.line, end).join('\n') };
  });
}

/** Anchors from the opening table of contents, in order. Stops at the first blank line after that list. */
export function guideToc(markdown: string): GuideTocEntry[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const out: GuideTocEntry[] = [];
  const seen = new Set<string>();
  let started = false;
  for (const line of lines) {
    if (/^#{1,6} /.test(line)) {
      if (started) break;
      continue;
    }
    const links = [...line.matchAll(/\[([^\]]+)\]\(#([A-Za-z0-9_-]+)\)/g)];
    if (!links.length) {
      if (started && line.trim() === '') break;
      continue;
    }
    started = true;
    for (const link of links) {
      const anchor = link[2].toLowerCase();
      if (seen.has(anchor)) continue;
      seen.add(anchor);
      out.push({ anchor, label: link[1] });
    }
  }
  return out;
}

/** TOC h2s only. Each slice extends to the next TOC heading, so a non-TOC h2 stays inside it. */
function tocSlices(markdown: string): GuideSection[] {
  const text = markdown.replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  const byAnchor = new Map(parseGuide(text).filter((section) => section.level === 2).map((section) => [section.anchor, section]));
  const located: { section: GuideSection; line: number }[] = [];
  for (const entry of guideToc(text)) {
    const section = byAnchor.get(entry.anchor);
    if (!section) continue;
    const line = lines.findIndex((row) => row === `${'#'.repeat(section.level)} ${section.title}`);
    if (line < 0) continue;
    located.push({ section, line });
  }
  return located.map((item, i) => {
    const end = i + 1 < located.length ? located[i + 1].line : lines.length;
    return { ...item.section, markdown: lines.slice(item.line, end).join('\n') };
  });
}

/** Full guide plus the visual contract. Served text is `guideText`, so relative links are rewritten. */
export function fullGuide(port: string | number): string {
  return guideText(Number(port));
}

/** GUIDE half of `guideText`. The second top-level heading is the appended visual contract. */
function splitServedGuide(served: string): { guide: string; style: string } {
  const lines = served.replace(/\r\n/g, '\n').split('\n');
  let fence: { char: string; size: number } | undefined;
  let seen = 0;
  for (let i = 0; i < lines.length; i++) {
    const fenceLine = FENCE.exec(lines[i]);
    if (fenceLine) {
      const token = fenceLine[1];
      const rest = fenceLine[2];
      if (!fence) {
        fence = { char: token[0], size: token.length };
        continue;
      }
      if (token[0] === fence.char && token.length >= fence.size && rest.trim() === '') fence = undefined;
      continue;
    }
    if (fence || !/^# /.test(lines[i])) continue;
    seen++;
    if (seen === 2) return { guide: lines.slice(0, i).join('\n').replace(/\n+$/, ''), style: lines.slice(i).join('\n') };
  }
  return { guide: served.replace(/\n+$/, ''), style: '' };
}

/**
 * Section slices are cut from `guideText`, not a second concat. Anchors that exist only
 * in the appended STYLE half become links to the full guide, so a slice does not carry
 * an in-page visual-contract anchor.
 */
function sliceSource(served: string, port: number): string {
  const { guide, style } = splitServedGuide(served);
  const outside = new Set(parseGuide(style).map((section) => section.anchor));
  const title = /^#\s+(.+)$/m.exec(style)?.[1]?.trim();
  if (title) outside.add(headingSlug(title));
  if (!outside.size) return guide;
  return guide.replace(/\]\(#([A-Za-z0-9_-]+)\)/g, (full, anchor: string) => outside.has(anchor) ? `](http://localhost:${port}/api/guide#${anchor})` : full);
}

/** Coordination playbooks an agent can follow without the rest of the guide. `centralized` is `lead`. */
export const PLAYBOOKS = ['decentralized', 'lead'] as const;
export type PlaybookName = (typeof PLAYBOOKS)[number];

const ALIAS: Record<string, PlaybookName | 'playbooks'> = {
  decentralized: 'decentralized',
  lead: 'lead',
  centralized: 'lead',
  playbooks: 'playbooks',
  index: 'playbooks',
};

export class GuideError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'GuideError';
    this.status = status;
  }
}

function playbooksSource(): string {
  const text = asset('PLAYBOOKS.md', 'utf8');
  if (!text) throw new GuideError(500, 'PLAYBOOKS.md is missing');
  return text.replaceAll('\r\n', '\n');
}

function canonical(name: string): PlaybookName | 'playbooks' {
  const id = ALIAS[name.trim().toLowerCase()];
  if (!id) throw new GuideError(400, `unknown playbook "${name}". Use decentralized or lead.`);
  return id;
}

/** The chooser page: which playbook to fetch, without either runbook. */
export function playbookIndex(): string {
  const text = playbooksSource();
  const marker = text.search(/\n<!-- playbook:[\w-]+ -->/);
  const head = (marker < 0 ? text : text.slice(0, marker)).trim();
  if (!head) throw new GuideError(500, 'PLAYBOOKS.md has no index');
  return `${head}\n`;
}

/** One self-contained runbook. */
export function playbookText(name: string): string {
  const id = canonical(name);
  if (id === 'playbooks') return playbookIndex();
  const text = playbooksSource();
  const token = `<!-- playbook:${id} -->`;
  const at = text.indexOf(token);
  if (at < 0) throw new GuideError(500, `playbook ${id} is not in PLAYBOOKS.md`);
  const from = text.indexOf('\n', at);
  const body = from < 0 ? '' : text.slice(from + 1);
  const next = body.search(/\n<!-- playbook:[\w-]+ -->/);
  const slice = (next < 0 ? body : body.slice(0, next)).trim();
  if (!slice.startsWith('## ')) throw new GuideError(500, `playbook ${id} has no heading`);
  return `${slice}\n`;
}

/**
 * What `hud guide` and `GET /api/guide` return.
 * No name: the full guide. `decentralized` or `lead`: that playbook only. `playbooks`: the chooser.
 */
export function coordinationDoc(which: string | null | undefined, port: string | number): string {
  const name = which?.trim();
  if (!name) return fullGuide(port);
  const id = canonical(name);
  return id === 'playbooks' ? playbookIndex() : playbookText(id);
}

export type GuideQuery = { section?: string | null; playbook?: string | null; format?: string | null };

export type GuideRender =
  | { status: 200; type: 'text/markdown; charset=utf-8'; body: string }
  | { status: 200; type: 'application/json'; body: { sections: { anchor: string; title: string; level: number }[] } }
  | { status: 200; type: 'application/json'; body: { anchor: string; title: string; level: number; markdown: string } }
  | { status: 200; type: 'application/json'; body: { playbook: string; markdown: string } }
  | { status: 400 | 500; type: 'application/json'; body: { error: string; sections?: string[] } };

function sectionOf(sections: GuideSection[], query: string): GuideSection | undefined {
  const wanted = query.trim().replace(/^#+/, '').trim();
  const slug = headingSlug(wanted);
  const lower = wanted.toLowerCase();
  return sections.find((s) => s.anchor === lower || s.anchor === slug || s.title.toLowerCase() === lower || headingSlug(s.title) === slug);
}

function asQuery(sectionOrQuery?: string | null | GuideQuery, format?: string | null): GuideQuery {
  if (sectionOrQuery && typeof sectionOrQuery === 'object') return sectionOrQuery;
  return { section: sectionOrQuery, format };
}

/**
 * Full guide, one TOC slice, one playbook, or a JSON catalog of TOC anchors.
 * A string second argument is a section anchor. Pass `{section, playbook, format}` to set either filter.
 */
export function renderGuide(port: number | string, sectionOrQuery?: string | null | GuideQuery, format?: string | null): GuideRender {
  const query = asQuery(sectionOrQuery, format);
  const kind = query.format === undefined || query.format === null || query.format.trim() === '' ? 'markdown' : query.format.trim().toLowerCase();
  if (kind !== 'markdown' && kind !== 'json') {
    return { status: 400, type: 'application/json', body: { error: 'format must be markdown or json' } };
  }
  const portNum = Number(port);
  const sectionName = (query.section?.trim() ?? '').replace(/^#+/, '').trim();
  const playbookName = query.playbook?.trim() ?? '';
  if (sectionName && playbookName) {
    return { status: 400, type: 'application/json', body: { error: 'pass section or playbook, not both' } };
  }
  if (playbookName) {
    try {
      const markdown = coordinationDoc(playbookName, port);
      if (kind === 'json') return { status: 200, type: 'application/json', body: { playbook: playbookName, markdown } };
      return { status: 200, type: 'text/markdown; charset=utf-8', body: markdown };
    } catch (e) {
      if (e instanceof GuideError) return { status: e.status === 500 ? 500 : 400, type: 'application/json', body: { error: e.message } };
      throw e;
    }
  }
  const served = guideText(portNum);
  const sections = tocSlices(sliceSource(served, portNum));
  if (!sectionName) {
    if (kind === 'json') {
      return { status: 200, type: 'application/json', body: { sections: sections.map(({ anchor, title, level }) => ({ anchor, title, level })) } };
    }
    return { status: 200, type: 'text/markdown; charset=utf-8', body: served };
  }
  const found = sectionOf(sections, query.section ?? sectionName);
  if (!found) {
    return {
      status: 400,
      type: 'application/json',
      body: { error: `unknown guide section "${query.section?.trim() ?? sectionName}"`, sections: sections.map((s) => s.anchor) },
    };
  }
  if (kind === 'json') {
    return { status: 200, type: 'application/json', body: { anchor: found.anchor, title: found.title, level: found.level, markdown: found.markdown } };
  }
  return { status: 200, type: 'text/markdown; charset=utf-8', body: found.markdown };
}

/** `hud://guide`, `hud://guide#<anchor>`, `hud://guide?section=`, `hud://guide?playbook=`, or `hud://playbook/<name>`. */
export function parseGuideResource(uri: string): { section?: string; playbook?: string } | undefined {
  const play = /^hud:\/\/playbook\/([A-Za-z0-9_-]+)$/.exec(uri);
  if (play) return { playbook: play[1] };
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'hud:' || url.hostname !== 'guide') return undefined;
  if (url.pathname !== '' && url.pathname !== '/') return undefined;
  const sectionQuery = url.searchParams.get('section')?.trim() ?? '';
  const playbookQuery = url.searchParams.get('playbook')?.trim() ?? '';
  let hash = url.hash.replace(/^#/, '').trim();
  try {
    hash = decodeURIComponent(hash).trim();
  } catch { /* keep the raw fragment */ }
  const section = sectionQuery || hash || undefined;
  if (playbookQuery && section) return { section, playbook: playbookQuery };
  if (playbookQuery) return { playbook: playbookQuery };
  return { section };
}
