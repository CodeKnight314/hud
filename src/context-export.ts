/** Durable run snapshots: a markdown report packed with attachment bytes. No store imports. */
import { crc32 } from 'node:zlib';

export interface RunZipFile {
  name: string;
  data: Buffer;
}

export interface RunExportDocument {
  ident: string;
  id: string;
  title: string;
  board: string;
  status: string;
  actor: string;
  exportedAt: string;
  entries: {
    seq: number;
    id: string;
    t: string;
    actor: string;
    session?: string;
    kind: string;
    text: string;
    data?: Record<string, unknown>;
    refs?: string[];
    attachments?: string[];
    corrects?: string;
  }[];
  files: {
    id: string;
    name: string;
    sha256: string;
    bytes: number;
    scope?: string;
    path?: string;
    note?: string;
  }[];
}

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const EOCD = 0x06054b50;
const ID_RE = /^[A-Za-z0-9][\w.-]{0,63}$/;

function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n & 0xffff);
  return b;
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
}

function dosStamp(d: Date): { time: number; date: number } {
  const year = Math.max(1980, Math.min(2107, d.getFullYear()));
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/** one path segment inside a snapshot; never empty, never a traversal */
export function zipSegment(raw: string): string {
  const safe = String(raw).replace(/[^\w.-]+/g, '_').replace(/^\.+/, '').slice(0, 80);
  return safe || 'file';
}

function assertZipName(name: string): void {
  if (!name || name.includes('\\') || name.startsWith('/') || name.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error(`bad zip entry name "${name}"`);
  }
}

/**
 * Make entry names unique. `zipSegment` maps both `a/b` and `a_b` to `a_b`; the second file
 * gets `-2`, `-3`, … before its extension. `reserved` (for example `context.md`) is never reused.
 */
export function uniqueZipNames(names: string[], reserved: string[] = []): string[] {
  const used = new Set(reserved);
  return names.map((name) => {
    assertZipName(name);
    const slash = name.lastIndexOf('/');
    const dot = name.lastIndexOf('.');
    const stem = dot > slash ? name.slice(0, dot) : name;
    const ext = dot > slash ? name.slice(dot) : '';
    let candidate = name;
    for (let n = 1; n < 10000; n++) {
      if (n > 1) candidate = `${stem}-${n}${ext}`;
      if (used.has(candidate)) continue;
      assertZipName(candidate);
      used.add(candidate);
      return candidate;
    }
    throw new Error(`duplicate zip entry "${name}"`);
  });
}

/** Uncompressed ZIP (method 0). Entry names are relative and have no `..` segments. Duplicate names throw. */
export function buildZip(files: RunZipFile[], when = new Date()): Buffer {
  if (files.length > 0xffff) throw new Error('zip has too many entries');
  const seen = new Set<string>();
  for (const file of files) {
    assertZipName(file.name);
    if (seen.has(file.name)) throw new Error(`duplicate zip entry "${file.name}"`);
    seen.add(file.name);
  }
  const { time, date } = dosStamp(when);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const size = file.data.length;
    if (size > 0xffffffff || name.length > 0xffff) throw new Error('zip entry is too large');
    const crc = crc32(file.data) >>> 0;
    const local = Buffer.concat([
      u32(LOCAL), u16(20), u16(0), u16(0), u16(time), u16(date),
      u32(crc), u32(size), u32(size), u16(name.length), u16(0),
      name, file.data,
    ]);
    const central = Buffer.concat([
      u32(CENTRAL), u16(20), u16(20), u16(0), u16(0), u16(time), u16(date),
      u32(crc), u32(size), u32(size), u16(name.length), u16(0), u16(0),
      u16(0), u16(0), u32(0), u32(offset),
      name,
    ]);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
    if (offset > 0xffffffff) throw new Error('zip is too large');
  }
  const centralDir = centrals.length ? Buffer.concat(centrals) : Buffer.alloc(0);
  if (centralDir.length > 0xffffffff || offset + centralDir.length > 0xffffffff) throw new Error('zip is too large');
  const end = Buffer.concat([
    u32(EOCD), u16(0), u16(0), u16(files.length), u16(files.length),
    u32(centralDir.length), u32(offset), u16(0),
  ]);
  return Buffer.concat([...locals, centralDir, end]);
}

/** Read the local files of a snapshot this module wrote. Refuses compressed or data-descriptor entries. */
export function listZipEntries(zip: Buffer): RunZipFile[] {
  const out: RunZipFile[] = [];
  let offset = 0;
  while (offset + 30 <= zip.length) {
    const sig = zip.readUInt32LE(offset);
    if (sig !== LOCAL) break;
    const flags = zip.readUInt16LE(offset + 6);
    const method = zip.readUInt16LE(offset + 8);
    const crc = zip.readUInt32LE(offset + 14);
    const compressed = zip.readUInt32LE(offset + 18);
    const size = zip.readUInt32LE(offset + 22);
    const nameLen = zip.readUInt16LE(offset + 26);
    const extraLen = zip.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLen + extraLen;
    const dataEnd = dataStart + compressed;
    if (dataEnd > zip.length) throw new Error('truncated zip entry');
    const name = zip.subarray(nameStart, nameStart + nameLen).toString('utf8');
    if (method !== 0 || (flags & 0x8) !== 0) throw new Error(`unsupported zip entry ${name}`);
    const data = Buffer.from(zip.subarray(dataStart, dataEnd));
    if (data.length !== size || (crc32(data) >>> 0) !== crc) throw new Error(`zip entry crc mismatch for ${name}`);
    out.push({ name, data });
    offset = dataEnd;
  }
  return out;
}

export function zipEntry(zip: Buffer, name: string): Buffer {
  const found = listZipEntries(zip).find((entry) => entry.name === name);
  if (!found) throw new Error(`zip has no ${name}`);
  return found.data;
}

/**
 * `context-<id>-<YYYYMMDD-HHMMSS>[-n].zip`. The id is taken from the last timestamp,
 * so an id that itself contains digits and hyphens still round-trips.
 */
export function parseContextExportName(name: string): { runId: string } | undefined {
  if (typeof name !== 'string' || name.includes('/') || name.includes('\\')) return undefined;
  const m = /^context-(.+)-\d{8}-\d{6}(?:-\d+)?\.zip$/.exec(name);
  if (!m || !ID_RE.test(m[1]!)) return undefined;
  return { runId: m[1]! };
}

function fence(body: string, lang = ''): string {
  const runs = body.match(/`+/g) ?? [];
  const n = Math.max(3, ...runs.map((s) => s.length)) + 1;
  const tick = '`'.repeat(n);
  return `${tick}${lang}\n${body}\n${tick}`;
}

function cell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function heading(value: string): string {
  return value.replace(/[\r\n]+/g, ' ');
}

/** The human-readable half of a run snapshot. Attachment bytes live beside this file in the zip. */
export function renderRunMarkdown(doc: RunExportDocument): string {
  const lines = [
    `# ${heading(doc.title)}`,
    '',
    `- ident: ${doc.ident}`,
    `- id: ${doc.id}`,
    `- board: ${doc.board}`,
    `- status: ${doc.status}`,
    `- exported: ${doc.exportedAt}`,
    `- actor: ${doc.actor}`,
    '',
    '## Context',
    '',
  ];
  if (!doc.entries.length) lines.push('No context entries.', '');
  for (const entry of doc.entries) {
    lines.push(`### ${entry.seq} ${entry.kind} · ${entry.t} · ${heading(entry.actor)}${entry.session ? ` · ${heading(entry.session)}` : ''}`, '', fence(entry.text), '');
    if (entry.data) lines.push(fence(JSON.stringify(entry.data, null, 2), 'json'), '');
    if (entry.refs?.length) lines.push(`refs: ${entry.refs.join(', ')}`, '');
    if (entry.attachments?.length) lines.push(`attachments: ${entry.attachments.join(', ')}`, '');
    if (entry.corrects) lines.push(`corrects: ${entry.corrects}`, '');
  }
  lines.push('## Attachments', '');
  if (!doc.files.length) lines.push('No attachments.', '');
  else {
    lines.push('| id | name | bytes | sha256 | path | note |', '|---|---|---:|---|---|---|');
    for (const file of doc.files) {
      lines.push(`| ${cell(file.id)} | ${cell(file.name)} | ${file.bytes} | ${cell(file.sha256)} | ${cell(file.path ?? '—')} | ${cell(file.note ?? '—')} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
