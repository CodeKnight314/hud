// Open the hud data directory in the system file manager. The path is chosen by the server, never the request.
import { spawn } from 'node:child_process';

export function revealCommand(platform = process.platform): { command: string; args: (dir: string) => string[] } {
  if (platform === 'darwin') return { command: 'open', args: (dir) => [dir] };
  if (platform === 'win32') return { command: 'explorer', args: (dir) => [dir] };
  return { command: 'xdg-open', args: (dir) => [dir] };
}

export function launchDetached(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

export function revealDirectory(dir: string, launch: (command: string, args: string[]) => void | Promise<void> = launchDetached): void | Promise<void> {
  if (typeof dir !== 'string' || !dir.trim()) throw new Error('data directory is unknown');
  const spec = revealCommand();
  return launch(spec.command, spec.args(dir));
}
