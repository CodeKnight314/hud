import { closeSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';

interface LockInfo {
  pid: number;
  port: number;
  startedAt: number;
}

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readLock(file: string): LockInfo | undefined {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8'));
    return v && typeof v === 'object' ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Single writer per data dir: `<dataDir>/hud.lock` is created exclusively. A lock whose pid is still
 * running refuses (throws); a dead or unreadable one is taken over. Returns a release function.
 */
export function acquireLock(dataDir: string, port: number): () => void {
  const file = join(dataDir, 'hud.lock');
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const fd = openSync(file, 'wx');
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, port, startedAt: Date.now() } satisfies LockInfo));
      } finally {
        closeSync(fd);
      }
      return () => {
        if (readLock(file)?.pid === process.pid) rmSync(file, { force: true });
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    const held = readLock(file);
    if (held && held.pid !== process.pid && alive(held.pid))
      throw new Error(`hud is already running for ${dataDir} on port ${held.port} (pid ${held.pid})`);
    rmSync(file, { force: true }); // dead owner (or our own pid after a crash-restart): take over
  }
  throw new Error(`could not take the lock ${file}`);
}
