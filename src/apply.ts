/** Apply an attachment to a local file with conflict detection. Runs in the agent's process, never the server. */
import { createHash } from 'node:crypto';
import { copyFileSync, lstatSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { Hud } from './client.ts';
import { HudError } from './store.ts';

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

export interface ApplyResult {
  path: string;
  sha256: string;
  backup?: string;
  attachment: string;
}

export async function applyAttachment(hud: Hud, id: string, opts: { target: string; expectedSha256?: string; mode?: 'create' | 'overwrite' }): Promise<ApplyResult> {
  if (!opts.target || !isAbsolute(opts.target)) throw new HudError(400, 'target must be an absolute path');
  const record = await hud.attachment(id);
  const bytes = await hud.attachmentBytes(id);
  const hash = sha256(bytes);
  if (record.sha256 && record.sha256 !== hash) throw new HudError(409, 'attachment content does not match its published hash', { code: 'attachment-mismatch' });

  const target = resolve(opts.target);
  let st;
  try {
    st = lstatSync(target);
  } catch {}
  if (st?.isSymbolicLink()) throw new HudError(403, 'target is a symlink; apply to the real file instead');
  if (st && !st.isFile()) throw new HudError(400, 'target is not a regular file');
  const current = st ? sha256(readFileSync(target)) : undefined;
  const mode = opts.mode ?? 'overwrite';
  if (mode === 'create' && current !== undefined) throw new HudError(409, 'target already exists', { code: 'exists', path: target });
  if (current !== undefined) {
    const expected = opts.expectedSha256 ?? record.baseSha256;
    if (!expected) throw new HudError(409, 'target exists; pass expectedSha256 (the hash you based your work on) to overwrite it', { code: 'conflict', actual: current });
    if (expected !== current) throw new HudError(409, 'target changed since the attachment was published', { code: 'conflict', expected, actual: current });
  }

  let backup: string | undefined;
  if (current !== undefined) {
    backup = `${target}.hud-backup-${Date.now()}`;
    copyFileSync(target, backup);
  }
  const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, bytes, { mode: 0o644 });
  renameSync(tmp, target);
  await hud.attachmentApplied(id, target);
  return { path: target, sha256: hash, backup, attachment: id };
}
