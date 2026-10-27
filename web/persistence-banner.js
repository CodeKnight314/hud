// Persistence chrome for GET /api/health saveError / recoveredFrom. No dismiss control:
// the banner stays until health stops reporting either field.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function field(value) {
  return typeof value === 'string' && value.trim() ? value : '';
}

/** null when the board is saving normally and was not recovered from a backup */
export function persistenceNotice(health) {
  const saveError = field(health?.saveError);
  const recoveredFrom = field(health?.recoveredFrom);
  if (!saveError && !recoveredFrom) return null;
  const parts = [];
  if (recoveredFrom) parts.push(`recovered from backup ${recoveredFrom}`);
  if (saveError) parts.push(`not saving: ${saveError}`);
  return {
    glyph: saveError ? '✕' : '▲',
    text: parts.join(' · '),
    saveError,
    recoveredFrom,
    dismissible: false,
    actions: [
      { id: 'open-data-dir', label: 'open data dir' },
      { id: 'restore', label: 'restore' },
    ],
  };
}

/** markup for the notice; a dismissible model renders nothing */
export function persistenceBannerHTML(notice) {
  if (!notice || notice.dismissible !== false) return '';
  const actions = notice.actions.map((action) => `<button type="button" data-persistence="${esc(action.id)}">${esc(action.label)}</button>`).join('');
  return `<span class="persistence-glyph" aria-hidden="true">${esc(notice.glyph)}</span><p class="persistence-text">${esc(notice.text)}</p>${actions}`;
}

/** recovered snapshot when health names one, otherwise the newest backup */
export function restoreTarget(notice, backups) {
  if (!notice) return '';
  if (notice.recoveredFrom) return notice.recoveredFrom;
  const name = backups?.[0]?.name;
  return typeof name === 'string' && name ? name : '';
}
