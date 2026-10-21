/** Attachment bytes: stored under <dataDir>/attachments, never inside state.json. */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { config } from './config.ts';
import { HudError } from './store.ts';
import type { AttachmentRecord } from './types.ts';

export const ATTACHMENT_MAX_BYTES = 2 * 1024 * 1024;

/** a safe file name: basename only, no separators, no leading dot */
export function sanitizeName(name: string): string {
  const base = String(name ?? '').split(/[\\/]/).pop() ?? '';
  const safe = base.replace(/[^\w.@+-]+/g, '_').replace(/^\.+/, '').slice(0, 120);
  if (!safe) throw new HudError(400, 'attachment name is empty or invalid');
  return safe;
}

/** tests redirect stored bytes here; the server always uses the data dir */
let rootOverride: string | null = null;
export function setAttachmentsRoot(dir: string | null): void {
  rootOverride = dir;
}

export function attachmentsRoot(): string {
  return rootOverride ?? join(config().dataDir, 'attachments');
}

export function attachmentPath(record: Pick<AttachmentRecord, 'board' | 'id' | 'name'>): string {
  const root = resolve(attachmentsRoot());
  const path = resolve(root, record.board, record.id, sanitizeName(record.name));
  if (!path.startsWith(root + sep)) throw new HudError(403, 'attachment path escapes the attachment root');
  return path;
}

export function hashBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** write bytes atomically and return the hash; the caller records the metadata */
export function writeAttachmentBytes(board: string, id: string, name: string, bytes: Buffer): { sha256: string; bytes: number } {
  if (!bytes.length) throw new HudError(400, 'attachment is empty');
  if (bytes.length > ATTACHMENT_MAX_BYTES) throw new HudError(413, `attachment is too large (${bytes.length} > ${ATTACHMENT_MAX_BYTES} bytes)`);
  const path = attachmentPath({ board, id, name });
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, bytes, { mode: 0o600 });
  renameSync(tmp, path);
  return { sha256: hashBytes(bytes), bytes: bytes.length };
}

/** read a stored attachment, refusing symlinks, directories and oversized files */
export function readAttachmentBytes(record: AttachmentRecord): Buffer {
  const path = attachmentPath(record);
  let st;
  try {
    st = lstatSync(path);
  } catch {
    throw new HudError(404, `attachment file is missing for ${record.id}`);
  }
  if (st.isSymbolicLink() || !st.isFile()) throw new HudError(403, 'attachment path is not a regular file');
  if (st.size > ATTACHMENT_MAX_BYTES) throw new HudError(413, 'stored attachment exceeds the size limit');
  const real = realpathSync(path);
  const root = realpathSync(attachmentsRoot());
  if (!real.startsWith(root + sep)) throw new HudError(403, 'attachment path escapes the attachment root');
  return readFileSync(real);
}

export function removeAttachmentBytes(record: AttachmentRecord): void {
  const path = attachmentPath(record);
  if (!existsSync(path)) return;
  rmSync(dirname(path), { recursive: true, force: true });
}

/** UTF-8 text when it is safely decodable, otherwise null */
export function textOf(bytes: Buffer): string | null {
  if (bytes.includes(0)) return null;
  const text = bytes.toString('utf8');
  // invalid UTF-8 turns into replacement characters; reject rather than show a mangled diff
  return text.includes('�') ? null : text;
}
