// Git working tree status for a repo: value = uncommitted files, message = branch + ahead/behind.
// source: { kind: "probe", probe: "git", config: { repo: "/path/to/repo" }, interval: 30 }
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
export const interval = 30;

export default async function (ctx: any) {
  const cwd = String(ctx.config.repo ?? process.cwd());
  const { stdout } = await run('git', ['status', '--porcelain=v1', '--branch'], { cwd });
  const [head, ...files] = stdout.trim().split('\n');
  const branch = head.replace(/^## /, '');
  const n = files.filter(Boolean).length;
  return { value: n, unit: ' files', state: n ? 'warn' : 'ok', message: branch };
}
