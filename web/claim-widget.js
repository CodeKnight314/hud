// Glanceable claim/queue summary for the board canvas. Pure: the page supplies queue + sessions.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Remaining lease, rounded up to the next second. Hours drop leftover seconds. */
export function formatClaimTtl(expiresAt, now) {
  const end = Number(expiresAt);
  const at = Number(now);
  if (!Number.isFinite(end) || !Number.isFinite(at)) return '—';
  const ms = end - at;
  if (ms <= 0) return 'expired';
  const sec = Math.ceil(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  if (min < 60) return rem ? `${min}m ${rem}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${hr}h ${m}m` : `${hr}h`;
}

function sessionName(row, sessions) {
  const id = String(row.claim?.session || '');
  const fromList = (sessions?.items || []).find((s) => s.id === id);
  const name = String(fromList?.name || row.session?.name || id).trim();
  return name || id || 'session';
}

function claimRows(queue, sessions, now) {
  const rows = [];
  for (const row of queue.items || []) {
    if (!row?.claim) continue;
    const name = sessionName(row, sessions);
    const expiresAt = Number(row.claim.expiresAt);
    const leaseLive = row.claim.live !== false && expiresAt > now;
    const holderLive = row.session ? row.session.live !== false : true;
    rows.push({
      ticket: String(row.id || ''),
      ident: String(row.ident || row.claim.ident || ''),
      title: String(row.title || ''),
      sessionName: name,
      ttl: formatClaimTtl(expiresAt, now),
      live: leaseLive && holderLive,
      expiresAt: Number.isFinite(expiresAt) ? expiresAt : Number.POSITIVE_INFINITY,
    });
  }
  rows.sort((a, b) => a.expiresAt - b.expiresAt || a.sessionName.localeCompare(b.sessionName) || a.ticket.localeCompare(b.ticket));
  return rows;
}

/** Empty when there is nothing claimed and nothing ready, so a quiet board stays clear. */
export function claimWidgetHTML({ queue, sessions, now = Date.now(), limit = 4 } = {}) {
  if (!queue?.counts) return '';
  const ready = Math.max(0, Number(queue.counts.ready) || 0);
  const claims = claimRows(queue, sessions, now);
  if (!claims.length && ready <= 0) return '';
  const shown = claims.slice(0, Math.max(0, limit));
  const rest = claims.length - shown.length;
  const head = `<div class="cw-head" data-ready="${ready}"><span class="cw-label">queue</span><span class="cw-ready">${ready} ready</span></div>`;
  const rows = shown.map((c) => {
    const tip = `${c.sessionName} · ${c.ident}${c.title ? ` · ${c.title}` : ''} · ${c.ttl}`;
    return `<button type="button" class="cw-row${c.live ? '' : ' cw-stale'}" data-claim-focus="${esc(c.ticket)}" data-claim-session="${esc(c.sessionName)}" data-claim-ttl="${esc(c.ttl)}" title="${esc(tip)}"><span aria-hidden="true">${c.live ? '●' : '○'}</span><span class="cw-name">${esc(c.sessionName)}</span><span class="cw-ident">${esc(c.ident)}</span><span class="cw-ttl">${esc(c.ttl)}</span></button>`;
  }).join('');
  const more = rest > 0 ? `<div class="cw-more">+${rest} more</div>` : '';
  return head + rows + more;
}
