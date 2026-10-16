// hud — on-canvas utilities (timers, clock, counter, calculator, sheet, …).
//
// Pure logic lives at the top and is DOM-free, so Node can import this file to verify the calculator
// and the spreadsheet's arithmetic (`node -e "import('./web/utils.js').then(m => m.evaluate('2+2'))"`).
// Everything below `renderCard` only builds strings.

export const UTIL_KINDS = ['timer', 'stopwatch', 'clock', 'counter', 'calculator', 'sheet', 'markdown', 'dice'];

export const UTIL_LABEL = {
  timer: 'timer',
  stopwatch: 'stopwatch',
  clock: 'clock',
  counter: 'counter',
  calculator: 'calculator',
  sheet: 'spreadsheet',
  markdown: 'markdown',
  dice: 'dice',
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const MAX_ROWS = 500, MAX_COLS = 52;
const dim = (v, d, max) => clamp(Math.floor(num(v, d)), 1, max);
const list = (v) => (Array.isArray(v) ? v : []); // util state is free-form JSON: never trust its shape

// ---------------------------------------------------------------- markdown (shared by notes, ticket bodies, the markdown util)

const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

function safeHref(value) {
  const href = String(value ?? '').trim();
  if (!href || /[\u0000-\u001f\u007f\s]/.test(href)) return null;
  try {
    const url = new URL(href);
    return SAFE_PROTOCOLS.has(url.protocol.toLowerCase()) ? href : null;
  } catch {
    return null;
  }
}

function markerAt(source, i) {
  const triple = source.slice(i, i + 3);
  if (triple === '***' || triple === '___') return triple;
  const double = source.slice(i, i + 2);
  if (double === '**' || double === '__') return double;
  if (source[i] === '*' || source[i] === '_') return source[i];
  return '';
}

function markerRun(source, i, marker) {
  let n = 0;
  while (source[i + n] === marker[0]) n++;
  return n;
}

function markerCanOpen(source, i, marker) {
  if (!source[i + marker.length] || /\s/.test(source[i + marker.length])) return false;
  if (marker[0] === '_' && i > 0 && /\w/.test(source[i - 1])) return false;
  return true;
}

function markerCanClose(source, i, marker) {
  if (i <= 0 || /\s/.test(source[i - 1])) return false;
  if (marker[0] === '_' && i + marker.length < source.length && /\w/.test(source[i + marker.length])) return false;
  return true;
}

function closingMarker(source, from, marker) {
  for (let i = from; i < source.length; i++) {
    if (!source.startsWith(marker, i)) continue;
    const run = markerRun(source, i, marker);
    if (marker.length === 1 && run > 1) {
      if (run >= 3) return i + run - 1;
      i += run - 1;
      continue;
    }
    if (!markerCanClose(source, i, marker)) continue;
    if (marker.length === 2 && run > marker.length) return i + run - marker.length;
    return i;
  }
  return -1;
}

function emphasis(s, depth = 0) {
  const source = String(s ?? '');
  if (depth >= 32) return esc(source);
  let html = '';
  let plain = '';
  const flush = () => {
    if (plain) html += esc(plain);
    plain = '';
  };
  for (let i = 0; i < source.length;) {
    const marker = markerAt(source, i);
    if (marker && markerCanOpen(source, i, marker)) {
      const end = closingMarker(source, i + marker.length, marker);
      if (end > i + marker.length) {
        flush();
        const content = emphasis(source.slice(i + marker.length, end), depth + 1);
        html += marker.length === 1 ? `<i>${content}</i>` : marker.length === 2 ? `<b>${content}</b>` : `<b><i>${content}</i></b>`;
        i = end + marker.length;
        continue;
      }
    }
    plain += source[i++];
  }
  flush();
  return html;
}

function linkAt(source, start, allowImage = false) {
  if (source[start] !== '[' || (!allowImage && source[start - 1] === '!')) return null;
  let close = start + 1;
  while (close < source.length && source[close] !== ']') close++;
  if (source[close] !== ']' || source[close + 1] !== '(') return null;
  let end = close + 2;
  let depth = 0;
  while (end < source.length) {
    const c = source[end];
    if (c === '(') depth++;
    else if (c === ')' && depth-- === 0) break;
    end++;
  }
  if (source[end] !== ')') return null;
  const url = source.slice(close + 2, end).trim();
  return { end: end + 1, label: source.slice(start + 1, close), url, raw: source.slice(start, end + 1) };
}

function stripLinks(source) {
  let out = '';
  for (let i = 0; i < source.length;) {
    const image = source[i] === '!' && source[i + 1] === '[';
    const start = image ? i + 1 : i;
    const link = source[start] === '[' ? linkAt(source, start, image) : null;
    if (link) {
      out += link.label;
      i = link.end;
    } else {
      out += source[i++];
    }
  }
  return out;
}

function inline(s) {
  const source = String(s ?? '');
  let html = '';
  let plain = '';
  const flush = () => {
    if (plain) html += emphasis(plain);
    plain = '';
  };
  for (let i = 0; i < source.length;) {
    if (source[i] === '`') {
      let run = 1;
      while (source[i + run] === '`') run++;
      const fence = '`'.repeat(run);
      const end = source.indexOf(fence, i + run);
      if (end >= 0) {
        flush();
        html += `<code>${esc(source.slice(i + run, end))}</code>`;
        i = end + run;
        continue;
      }
    }
    if (source[i] === '[') {
      const link = linkAt(source, i);
      if (link) {
        flush();
        const href = safeHref(link.url);
        html += href ? `<a href="${esc(href)}">${inline(link.label)}</a>` : esc(link.raw);
        i = link.end;
        continue;
      }
    }
    if (source[i] === '<') {
      const end = source.indexOf('>', i + 1);
      if (end >= 0) {
        const candidate = source.slice(i + 1, end).trim();
        const href = safeHref(candidate);
        if (href) {
          flush();
          html += `<a href="${esc(href)}">${esc(candidate)}</a>`;
          i = end + 1;
          continue;
        }
      }
    }
    plain += source[i++];
  }
  flush();
  return html;
}

function tableCells(line) {
  let source = String(line ?? '').trim();
  if (!source.includes('|')) return null;
  if (source.startsWith('|')) source = source.slice(1);
  if (source.endsWith('|') && !source.endsWith('\\|')) source = source.slice(0, -1);
  const cells = [];
  let cell = '';
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\\' && source[i + 1] === '|') {
      cell += '|';
      i++;
    } else if (source[i] === '|') {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += source[i];
    }
  }
  cells.push(cell.trim());
  return cells;
}

function tableSeparator(line) {
  const cells = tableCells(line);
  return !!cells?.length && cells.every((cell) => /^:?-+:?$/.test(cell));
}

function tableHTML(lines) {
  const head = tableCells(lines[0]) || [];
  const separator = tableCells(lines[1]) || [];
  const align = separator.map((cell) => (cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : 'left'));
  const cellHTML = (tag, cell, col) => `<${tag} style="text-align:${align[col] || 'left'}">${inline(cell)}</${tag}>`;
  const rows = lines.slice(2).map((row) => {
    const cells = tableCells(row) || [];
    return `<tr>${cells.map((cell, col) => cellHTML('td', cell, col)).join('')}</tr>`;
  });
  return `<div class="md-table"><table><thead><tr>${head.map((cell, col) => cellHTML('th', cell, col)).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}

function listItem(line, lineNumber, readonly) {
  const match = line.match(/^(\s*)([-+*]|\d+[.)])\s+(.*)$/);
  if (!match) return '';
  const indent = match[1].replace(/ /g, '&nbsp;');
  const task = match[3].match(/^\[( |x|X)\](?:\s+(.*))?$/);
  if (!task) return `${indent}${inline(match[3])}`;
  const done = task[1] !== ' ';
  const glyph = done ? '☒' : '☐';
  const check = readonly || match[2] !== '-' ? glyph : `<span class="chk" data-line="${lineNumber}">${glyph}</span>`;
  const body = inline(task[2] || '');
  return `${indent}${check} ${done ? `<span class="done">${body}</span>` : body}`;
}

function listMatch(line) {
  const match = line.match(/^\s*(?:[-+*]|\d+[.)])\s+/);
  if (!match) return null;
  return /^\s*\d+[.)]\s+/.test(line) ? 'ol' : 'ul';
}

function fenceMatch(line) {
  const match = String(line).match(/^ {0,3}(`{3,}|~{3,}).*$/);
  return match ? { char: match[1][0], length: match[1].length } : null;
}

function isFenceEnd(line, fence) {
  const re = new RegExp(`^ {0,3}${fence.char}{${fence.length},}\\s*$`);
  return re.test(line);
}

function headingMatch(line) {
  const match = String(line).match(/^ {0,3}(#{1,3})(?:[ \t]+(.*)|[ \t]*)$/);
  if (!match) return null;
  return { level: match[1].length, text: (match[2] || '').replace(/[ \t]+#+[ \t]*$/, '').trim() };
}

/** markdown subset -> HTML. Default mode retains note task-list click hooks. */
export function md(text, options = {}) {
  const readonly = !!options?.readonly;
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    if (!lines[i].trim()) { i++; continue; }
    const fence = fenceMatch(lines[i]);
    if (fence) {
      const code = [];
      i++;
      while (i < lines.length && !isFenceEnd(lines[i], fence)) code.push(lines[i++]);
      if (i < lines.length) i++;
      out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
      continue;
    }
    const heading = headingMatch(lines[i]);
    if (heading) {
      out.push(`<h${heading.level} class="h">${inline(heading.text)}</h${heading.level}>`);
      i++;
      continue;
    }
    if (tableCells(lines[i]) && tableSeparator(lines[i + 1] || '')) {
      const rows = [lines[i], lines[i + 1]];
      i += 2;
      while (i < lines.length && lines[i].trim() && tableCells(lines[i])) rows.push(lines[i++]);
      out.push(tableHTML(rows));
      continue;
    }
    const kind = listMatch(lines[i]);
    if (kind) {
      const items = [];
      while (i < lines.length && listMatch(lines[i]) === kind) {
        items.push(`<li>${listItem(lines[i], i, readonly)}</li>`);
        i++;
      }
      out.push(`<${kind}>${items.join('')}</${kind}>`);
      continue;
    }
    const paragraph = [];
    while (i < lines.length && lines[i].trim()) {
      if (paragraph.length && (fenceMatch(lines[i]) || headingMatch(lines[i]) || listMatch(lines[i]) || (tableCells(lines[i]) && tableSeparator(lines[i + 1] || '')))) break;
      paragraph.push(inline(lines[i++]));
    }
    out.push(`<p>${paragraph.join('<br>')}</p>`);
  }
  return out.join('');
}

/** Strip the supported Markdown syntax for compact, human-readable excerpts. */
export function plainText(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let fence = null;
  for (const sourceLine of lines) {
    if (fence) {
      if (isFenceEnd(sourceLine, fence)) fence = null;
      else out.push(sourceLine);
      continue;
    }
    const opening = fenceMatch(sourceLine);
    if (opening) { fence = opening; continue; }
    if (tableSeparator(sourceLine)) continue;
    const table = tableCells(sourceLine);
    let line = table ? table.join(' | ') : sourceLine;
    line = stripLinks(line)
      .replace(/^ {0,3}#{1,3}[ \t]+/, '')
      .replace(/^\s*[-+*]\s+\[( |x|X)\]\s*/, (_, mark) => (mark === ' ' ? '☐ ' : '☒ '))
      .replace(/^\s*[-+*]\s+/, '')
      .replace(/^\s*\d+[.)]\s+/, '')
      .replace(/`+([^`]*?)`+/g, '$1')
      .replace(/(__|\*\*)([\s\S]*?)\1/g, '$2')
      .replace(/(^|[^\w])(_|\*)(?=\S)([\s\S]*?\S)\2(?!\w)/g, '$1$3')
      .replace(/<((?:https?|mailto):[^>\s]+)>/gi, '$1')
      .replace(/<\/?[A-Za-z][^>]*>/g, '')
      .replace(/\\([\\`*_[\]{}()#+.!-])/g, '$1');
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Render a report as escaped plain text or non-interactive Markdown. */
export function reportHTML(text, format = 'plain') {
  const value = String(text ?? '');
  const kind = String(format ?? 'plain').toLowerCase();
  if (kind === 'md' || kind === 'markdown' || kind === 'rich') return md(value, { readonly: true });
  return esc(value.replace(/\r\n?/g, '\n')).replace(/\n/g, '<br>');
}

// ---------------------------------------------------------------- safe arithmetic (no eval, no Function)

const FUNCS = {
  abs: Math.abs, round: Math.round, floor: Math.floor, ceil: Math.ceil, sqrt: Math.sqrt,
  log: Math.log10, ln: Math.log, sin: Math.sin, cos: Math.cos, tan: Math.tan,
  min: (...a) => Math.min(...a.flat().map(Number)),
  max: (...a) => Math.max(...a.flat().map(Number)),
  pow: (a, b) => Math.pow(Number(a), Number(b)),
  sum: (...a) => a.flat().map(Number).filter(Number.isFinite).reduce((s, n) => s + n, 0),
  avg: (...a) => {
    const v = a.flat().map(Number).filter(Number.isFinite);
    return v.length ? v.reduce((s, n) => s + n, 0) / v.length : 0;
  },
  count: (...a) => a.flat().filter((v) => Number.isFinite(Number(v)) && v !== '' ).length,
  if: (c, a, b) => (c ? a : b),
};
const CONSTS = { pi: Math.PI, e: Math.E, tau: Math.PI * 2 };

/** tokenize: numbers, names, ranges (A1:B3), operators, parentheses */
function tokenize(src) {
  const out = [];
  const s = String(src);
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9.]/.test(c)) {
      let j = i;
      while (j < s.length && /[0-9._]/.test(s[j])) j++;
      const raw = s.slice(i, j).replace(/_/g, '');
      if (!/^\d*\.?\d+$/.test(raw)) throw new Error(`bad number "${raw}"`);
      out.push({ t: 'num', v: Number(raw) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j++;
      let name = s.slice(i, j);
      i = j;
      // cell range A1:B3
      if (/^[A-Za-z]+[0-9]+$/.test(name) && s[i] === ':') {
        let k = i + 1;
        while (k < s.length && /[A-Za-z0-9_]/.test(s[k])) k++;
        const to = s.slice(i + 1, k);
        if (!/^[A-Za-z]+[0-9]+$/.test(to)) throw new Error('bad range');
        out.push({ t: 'range', from: name, to });
        i = k;
        continue;
      }
      out.push({ t: 'name', v: name.toLowerCase() });
      continue;
    }
    if ('+-*/%^(),<>='.includes(c)) {
      // two-char comparisons
      const two = s.slice(i, i + 2);
      if (['>=', '<=', '<>'].includes(two)) { out.push({ t: 'op', v: two === '<>' ? '!=' : two }); i += 2; continue; }
      out.push({ t: 'op', v: c });
      i++;
      continue;
    }
    throw new Error(`unexpected "${c}"`);
  }
  return out;
}

/** recursive-descent parse to an AST */
function parse(src) {
  const tk = tokenize(src);
  let p = 0;
  const peek = () => tk[p];
  const eat = (v) => {
    const t = tk[p];
    if (!t || t.t !== 'op' || t.v !== v) throw new Error(`expected "${v}"`);
    p++;
    return t;
  };
  const primary = () => {
    const t = peek();
    if (!t) throw new Error('unexpected end');
    if (t.t === 'num') { p++; return { k: 'num', v: t.v }; }
    if (t.t === 'range') { p++; return { k: 'range', from: t.from.toLowerCase(), to: t.to.toLowerCase() }; }
    if (t.t === 'name') {
      p++;
      if (peek()?.t === 'op' && peek().v === '(') {
        eat('(');
        const args = [];
        if (!(peek()?.t === 'op' && peek().v === ')')) {
          args.push(expr());
          while (peek()?.t === 'op' && peek().v === ',') { eat(','); args.push(expr()); }
        }
        eat(')');
        return { k: 'call', name: t.v, args };
      }
      return { k: 'name', v: t.v };
    }
    if (t.t === 'op' && (t.v === '-' || t.v === '+')) { p++; return { k: 'unary', op: t.v, a: primary() }; }
    if (t.t === 'op' && t.v === '(') { eat('('); const e = expr(); eat(')'); return e; }
    throw new Error(`unexpected "${t.v}"`);
  };
  const power = () => {
    const a = primary();
    if (peek()?.t === 'op' && peek().v === '^') { p++; return { k: 'bin', op: '^', a, b: power() }; }
    return a;
  };
  const term = () => {
    let a = power();
    while (peek()?.t === 'op' && '*/%'.includes(peek().v)) {
      const op = peek().v;
      p++;
      a = { k: 'bin', op, a, b: power() };
    }
    return a;
  };
  const expr = () => {
    let a = term();
    while (peek()?.t === 'op' && '+-'.includes(peek().v)) {
      const op = peek().v;
      p++;
      a = { k: 'bin', op, a, b: term() };
    }
    for (;;) {
      const t = peek();
      if (t?.t === 'op' && ['>=', '<=', '>', '<', '=', '!='].includes(t.v)) {
        p++;
        a = { k: 'bin', op: t.v, a, b: term() };
      } else break;
    }
    return a;
  };
  const ast = expr();
  if (p < tk.length) throw new Error('trailing input');
  return ast;
}

/** A1:B3 → the lookup() of every cell in the rectangle; used by SUM/AVG/COUNT and friends */
function expandRange(from, to, lookup) {
  const m1 = /^([A-Za-z]+)(\d+)$/.exec(String(from));
  const m2 = /^([A-Za-z]+)(\d+)$/.exec(String(to));
  if (!m1 || !m2) return [];
  const c1 = colIndex(m1[1]), r1 = Number(m1[2]) - 1;
  const c2 = colIndex(m2[1]), r2 = Number(m2[2]) - 1;
  const out = [];
  // clamp to the largest grid a sheet can have: A1:B5000000 must not loop 10M times
  const ra = Math.max(0, Math.min(r1, r2)), rb = Math.min(MAX_ROWS - 1, Math.max(r1, r2));
  const ca = Math.max(0, Math.min(c1, c2)), cb = Math.min(MAX_COLS - 1, Math.max(c1, c2));
  for (let r = ra; r <= rb; r++)
    for (let c = ca; c <= cb; c++) out.push(lookup(`${colName(c)}${r + 1}`));
  return out;
}

/**
 * Evaluate an arithmetic expression. `lookup(name)` supplies identifiers (cell refs in a sheet);
 * passing nothing makes unknown names an error. Never evaluates code.
 */
export function evaluate(src, lookup) {
  const ast = parse(src);
  const walk = (n) => {
    switch (n.k) {
      case 'num': return n.v;
      case 'name': {
        if (n.v in CONSTS) return CONSTS[n.v];
        if (lookup) return lookup(n.v);
        throw new Error(`unknown name "${n.v}"`);
      }
      case 'range':
        if (!lookup) throw new Error('ranges need a sheet');
        return expandRange(n.from, n.to, lookup);
      case 'unary':
        return n.op === '-' ? -Number(walk(n.a)) : Number(walk(n.a));
      case 'call': {
        const fn = FUNCS[n.name];
        if (!fn) throw new Error(`unknown function "${n.name}"`);
        return fn(...n.args.map(walk));
      }
      case 'bin': {
        const a = walk(n.a);
        const b = walk(n.b);
        switch (n.op) {
          case '+': return Number(a) + Number(b);
          case '-': return Number(a) - Number(b);
          case '*': return Number(a) * Number(b);
          case '/': return Number(a) / Number(b);
          case '%': return Number(a) % Number(b);
          case '^': return Math.pow(Number(a), Number(b));
          case '>': return Number(a) > Number(b);
          case '<': return Number(a) < Number(b);
          case '>=': return Number(a) >= Number(b);
          case '<=': return Number(a) <= Number(b);
          case '=': return Number(a) === Number(b);
          case '!=': return Number(a) !== Number(b);
          default: throw new Error(`bad operator ${n.op}`);
        }
      }
      default:
        throw new Error('bad expression');
    }
  };
  return walk(ast);
}

// ---------------------------------------------------------------- spreadsheet

export const colName = (i) => {
  let s = '';
  let n = i;
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
};
export const colIndex = (name) => {
  let n = 0;
  for (const c of name.toUpperCase()) n = n * 26 + (c.charCodeAt(0) - 64);
  return n - 1;
};

/**
 * A sheet is stored as tab-separated rows in `text`, so it stays readable and MCP/CLI-writable.
 * Cells beginning with "=" are formulas over other cells (A1+B2, SUM(A1:A5)).
 */
export function parseSheet(text, rows = 8, cols = 5) {
  rows = dim(rows, 8, MAX_ROWS);
  cols = dim(cols, 5, MAX_COLS);
  const lines = String(text ?? '').split('\n');
  const grid = [];
  for (let r = 0; r < rows; r++) {
    const cells = (lines[r] ?? '').split('\t');
    const row = [];
    for (let c = 0; c < cols; c++) row.push(cells[c] ?? '');
    grid.push(row);
  }
  return grid;
}

/** resolve every cell, following formulas; cycles and division-by-zero become an error string, never a throw */
export function computeSheet(grid) {
  const rows = grid.length;
  const cols = grid[0]?.length ?? 0;
  const values = {};
  const status = new Map(); // 'ok' | 'busy' | 'bad'

  const cellAt = (ref) => {
    const m = /^([A-Za-z]+)(\d+)$/.exec(ref);
    if (!m) return undefined;
    const c = colIndex(m[1]);
    const r = Number(m[2]) - 1;
    if (r < 0 || r >= rows || c < 0 || c >= cols) return undefined;
    return { r, c, key: `${m[1].toUpperCase()}${r + 1}` };
  };

  const lookup = (ref) => {
    const key = ref.toUpperCase();
    const at = cellAt(key);
    if (!at) return 0;
    const st = status.get(key);
    if (st === 'busy') throw new Error('#cycle');
    if (st === 'bad') return '#err';
    if (st === 'ok') return values[key];
    const raw = String(grid[at.r][at.c] ?? '').trim();
    if (!raw) { values[key] = ''; status.set(key, 'ok'); return ''; }
    if (!raw.startsWith('=')) {
      const n = Number(raw);
      values[key] = Number.isFinite(n) ? n : raw;
      status.set(key, 'ok');
      return values[key];
    }
    status.set(key, 'busy');
    try {
      const v = evaluate(raw.slice(1), lookup);
      values[key] = typeof v === 'boolean' ? v : Number.isFinite(Number(v)) ? Number(v) : v;
      status.set(key, 'ok');
      return values[key];
    } catch (e) {
      values[key] = e.message === '#cycle' ? '#cycle' : '#err';
      status.set(key, 'bad');
      return values[key];
    }
  };

  const out = [];
  for (let r = 0; r < rows; r++) {
    const row = [];
    for (let c = 0; c < cols; c++) row.push(lookup(`${colName(c)}${r + 1}`));
    out.push(row);
  }
  return out;
}

// ---------------------------------------------------------------- live state

/** countdown remaining in seconds, from persisted state (so it keeps counting while you are away) */
export function timerRemaining(it, now = Date.now()) {
  const u = it.util ?? {};
  if (u.running && u.endsAt) return Math.max(0, (num(u.endsAt) - now) / 1000);
  return Math.max(0, num(u.remaining, num(u.seconds, 300)));
}

export function stopwatchElapsed(it, now = Date.now()) {
  const u = it.util ?? {};
  const base = num(u.elapsed, 0);
  return u.running && u.startedAt ? base + (now - num(u.startedAt)) / 1000 : base;
}

export function fmtDuration(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

function digits(sec) {
  const cs = Math.max(0, Math.floor(sec * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h ? `${h}:` : ''}${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}

/** whether a card needs a fast (animation-rate) redraw rather than the 5s tick */
export function isLive(it, now = Date.now()) {
  const u = it.util ?? {};
  if (it.kind === 'timer') return !!u.running && timerRemaining(it, now) > 0;
  if (it.kind === 'stopwatch') return !!u.running;
  if (it.kind === 'clock') return true;
  return false;
}

// ---------------------------------------------------------------- card rendering

const btn = (act, label, title) => `<button class="ubtn" data-util="${act}" title="${esc(title ?? label)}">${esc(label)}</button>`;

/** the body of a util card; app.js wires [data-util] clicks to a PATCH of item.util */
export function renderCard(it, now = Date.now()) {
  const u = it.util ?? {};
  switch (it.kind) {
    case 'timer': {
      const left = timerRemaining(it, now);
      const pct = u.seconds ? clamp((1 - left / num(u.seconds, 1)) * 100, 0, 100) : 0;
      const done = left <= 0;
      return `
        <div class="big ${done ? 'txt' : ''}">${done ? 'done' : fmtDuration(left)}</div>
        <div class="bar">${'█'.repeat(Math.round((pct / 100) * 18))}${'░'.repeat(18 - Math.round((pct / 100) * 18))}</div>
        <div class="urow">${u.running ? btn('pause', 'pause') : btn('start', done ? 'again' : 'start')}${btn('reset', 'reset')}${btn('plus5', '+5m')}</div>`;
    }
    case 'stopwatch':
      return `
        <div class="big">${digits(stopwatchElapsed(it, now))}</div>
        <div class="urow">${u.running ? btn('pause', 'pause') : btn('start', 'start')}${btn('lap', 'lap')}${btn('reset', 'reset')}</div>
        ${list(u.laps).length ? `<div class="lg">${list(u.laps).slice(-3).map((l, i) => `<div>${String(list(u.laps).length - i).padStart(2)} ${digits(num(l))}</div>`).join('')}</div>` : ''}`;
    case 'clock': {
      const d = new Date(now);
      const local = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const utc = d.toISOString().slice(11, 19);
      const date = d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
      return `<div class="big">${esc(local)}</div><div class="msg">utc ${esc(utc)}</div><div class="msg faint">${esc(date)}</div>`;
    }
    case 'counter': {
      const v = num(u.value, 0);
      const target = u.target == null ? null : num(u.target);
      const pct = target ? clamp((v / target) * 100, 0, 100) : null;
      return `
        <div class="big">${esc(String(v))}${target ? `<span class="u"> / ${esc(String(target))}</span>` : ''}</div>
        ${pct != null ? `<div class="bar">${'█'.repeat(Math.round((pct / 100) * 18))}${'░'.repeat(18 - Math.round((pct / 100) * 18))}</div>` : ''}
        <div class="urow">${btn('dec', `−${num(u.step, 1)}`)}${btn('inc', `+${num(u.step, 1)}`)}${btn('zero', 'zero')}</div>`;
    }
    case 'calculator': {
      const hist = list(u.history).slice(-3);
      return `
        <div class="big ${u.expr ? '' : 'txt'}">${esc(u.result ?? u.expr ?? '0')}</div>
        <div class="msg faint">${esc(u.expr ?? 'type an expression in the drawer')}</div>
        ${u.note ? `<div class="msg">${esc(u.note)}</div>` : ''}
        ${hist.length ? `<div class="lg">${hist.map((h) => `<div>${esc(h)}</div>`).join('')}</div>` : ''}`;
    }
    case 'sheet': {
      const rows = dim(u.rows, 8, MAX_ROWS), cols = dim(u.cols, 5, MAX_COLS);
      const grid = parseSheet(it.text, rows, cols);
      const values = computeSheet(grid);
      const head = `<tr><th></th>${Array.from({ length: cols }, (_, c) => `<th>${colName(c)}</th>`).join('')}</tr>`;
      const body = values
        .map((row, r) => `<tr><th>${r + 1}</th>${row.map((v) => `<td>${esc(v === '' ? '' : typeof v === 'number' ? Number(v.toFixed(6)) : v)}</td>`).join('')}</tr>`)
        .join('');
      return `<div class="sheet"><table>${head}${body}</table></div>`;
    }
    case 'markdown':
      return `<div class="md">${md(String(it.text ?? '').slice(0, 20000))}</div>`;
    case 'dice': {
      const sides = num(u.sides, 6);
      const rolls = list(u.rolls).slice(-8);
      return `
        <div class="big">${u.last == null ? '—' : esc(String(u.last))}</div>
        <div class="msg faint">d${esc(String(sides))}${rolls.length ? ` · last ${rolls.length}: ${esc(rolls.map(String).join(' '))}` : ''}</div>
        <div class="urow">${btn('roll', 'roll')}${btn('clear', 'clear')}</div>`;
    }
    default:
      return `<div class="msg faint">unknown utility "${esc(it.kind ?? '')}"</div>`;
  }
}

/** default util state for a freshly created kind */
export function defaultUtil(kind) {
  switch (kind) {
    case 'timer': return { seconds: 300, remaining: 300, running: false };
    case 'stopwatch': return { elapsed: 0, running: false, laps: [] };
    case 'counter': return { value: 0, step: 1 };
    case 'calculator': return { expr: '', history: [] };
    case 'sheet': return { rows: 8, cols: 5 };
    case 'dice': return { sides: 6, rolls: [] };
    default: return {};
  }
}
