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

function snapshotTime(value) {
  const t = Number(value);
  return Number.isFinite(t) ? t : null;
}

function sessionOf(row, sessions, queue) {
  const id = String(row.claim?.session || '');
  const fromList = (sessions?.items || []).find((s) => s.id === id) || null;
  const fromQueue = row.session || null;
  const sessionsAt = snapshotTime(sessions?.now);
  const queueAt = snapshotTime(queue?.now);
  // The session list overrides the queue row only when its snapshot is strictly newer.
  const listNewer = !!(fromList && sessionsAt != null && (queueAt == null || sessionsAt > queueAt));
  const chosen = listNewer ? fromList : (fromQueue || fromList);
  const other = chosen === fromList ? fromQueue : fromList;
  const name = String(chosen?.name || other?.name || id).trim() || id || 'session';
  const liveFlag = chosen && typeof chosen.live === 'boolean' ? chosen.live : other?.live;
  return { name, holderLive: liveFlag !== false };
}

function claimRows(queue, sessions, now) {
  const rows = [];
  for (const row of queue.items || []) {
    if (!row?.claim) continue;
    const session = sessionOf(row, sessions, queue);
    const expiresAt = Number(row.claim.expiresAt);
    const leaseLive = row.claim.live !== false && expiresAt > now;
    rows.push({
      ticket: String(row.id || ''),
      ident: String(row.ident || row.claim.ident || ''),
      title: String(row.title || ''),
      sessionName: session.name,
      ttl: formatClaimTtl(expiresAt, now),
      live: leaseLive && session.holderLive,
      expiresAt: Number.isFinite(expiresAt) ? expiresAt : Number.POSITIVE_INFINITY,
    });
  }
  rows.sort((a, b) => a.expiresAt - b.expiresAt || a.sessionName.localeCompare(b.sessionName) || a.ticket.localeCompare(b.ticket));
  return rows;
}

/** Empty when there is nothing claimed and nothing ready, so a quiet board stays clear. Every claim is listed. */
export function claimWidgetHTML({ queue, sessions, now = Date.now() } = {}) {
  if (!queue?.counts) return '';
  const ready = Math.max(0, Number(queue.counts.ready) || 0);
  const claims = claimRows(queue, sessions, now);
  if (!claims.length && ready <= 0) return '';
  const head = `<div class="cw-head" data-ready="${ready}"><span class="cw-label">queue</span><span class="cw-ready">${ready} ready</span></div>`;
  const rows = claims.map((c) => {
    const tip = `${c.sessionName} · ${c.ident}${c.title ? ` · ${c.title}` : ''} · ${c.ttl}`;
    return `<button type="button" class="cw-row${c.live ? '' : ' cw-stale'}" data-claim-focus="${esc(c.ticket)}" data-claim-session="${esc(c.sessionName)}" data-claim-live="${c.live ? '1' : '0'}" data-claim-ttl="${esc(c.ttl)}" title="${esc(tip)}"><span aria-hidden="true">${c.live ? '●' : '○'}</span><span class="cw-name">${esc(c.sessionName)}</span><span class="cw-ident">${esc(c.ident)}</span><span class="cw-ttl">${esc(c.ttl)}</span></button>`;
  }).join('');
  return head + rows;
}
