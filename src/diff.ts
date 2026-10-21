/** Bounded line diff used by attachment `expand`. Zero dependencies. */

export interface DiffResult {
  text: string;
  added: number;
  removed: number;
  truncated: boolean;
}

/** largest n*m LCS table we build; beyond it the files are reported as fully replaced */
const LCS_CELLS = 4_000_000;
const MAX_INPUT_LINES = 20_000;

type Op = { t: ' ' | '-' | '+'; line: string };

function replaceAll(a: string[], b: string[]): Op[] {
  return [...a.map(line => ({ t: '-' as const, line })), ...b.map(line => ({ t: '+' as const, line }))];
}

/** classic LCS table; deterministic on ties by preferring deletions */
function lcsOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const rows: Uint32Array[] = [new Uint32Array(m + 1)];
  for (let i = n - 1; i >= 0; i--) {
    const row = new Uint32Array(m + 1);
    const next = rows[0]!;
    for (let j = m - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? next[j + 1]! + 1 : Math.max(next[j]!, row[j + 1]!);
    }
    rows.unshift(row);
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ t: ' ', line: a[i]! }); i++; j++; }
    else if (rows[i + 1]![j]! >= rows[i]![j + 1]!) { ops.push({ t: '-', line: a[i]! }); i++; }
    else { ops.push({ t: '+', line: b[j]! }); j++; }
  }
  while (i < n) ops.push({ t: '-', line: a[i++]! });
  while (j < m) ops.push({ t: '+', line: b[j++]! });
  return ops;
}

function hunkRange(start: number, count: number): string {
  return count === 1 ? `${start + 1}` : count === 0 ? `${start},0` : `${start + 1},${count}`;
}

export function unifiedDiff(base: string, next: string, opts: { context?: number; maxLines?: number } = {}): DiffResult {
  const context = Math.max(0, Math.min(10, opts.context ?? 3));
  const maxLines = opts.maxLines ?? MAX_INPUT_LINES;
  const a = base.split('\n');
  const b = next.split('\n');
  const oversized = a.length + b.length > maxLines;
  const ops = oversized || a.length * b.length > LCS_CELLS ? replaceAll(a, b) : lcsOps(a, b);
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.t === '+') added++;
    else if (op.t === '-') removed++;
  }
  if (!added && !removed) return { text: '', added: 0, removed: 0, truncated: oversized };

  // group changes with `context` unchanged lines around them
  const keep = new Set<number>();
  ops.forEach((op, i) => {
    if (op.t === ' ') return;
    for (let k = Math.max(0, i - context); k <= Math.min(ops.length - 1, i + context); k++) keep.add(k);
  });
  const out: string[] = [];
  let i = 0;
  while (i < ops.length) {
    if (!keep.has(i)) { i++; continue; }
    let j = i;
    while (j < ops.length && keep.has(j)) j++;
    const slice = ops.slice(i, j);
    const oldCount = slice.filter(op => op.t !== '+').length;
    const newCount = slice.filter(op => op.t !== '-').length;
    const oldStart = ops.slice(0, i).filter(op => op.t !== '+').length;
    const newStart = ops.slice(0, i).filter(op => op.t !== '-').length;
    out.push(`@@ -${hunkRange(oldStart, oldCount)} +${hunkRange(newStart, newCount)} @@`);
    for (const op of slice) out.push(`${op.t}${op.line}`);
    i = j;
  }
  return { text: out.join('\n'), added, removed, truncated: oversized };
}
