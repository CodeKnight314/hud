import { asset } from './assets.ts';

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

/** Full guide plus the visual contract. `{{PORT}}` is filled from the server port. */
export function fullGuide(port: string | number): string {
  return `${asset('GUIDE.md', 'utf8') ?? ''}\n\n${asset('STYLE.md', 'utf8') ?? ''}`.replaceAll('{{PORT}}', String(port));
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
