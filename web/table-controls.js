document.addEventListener('click', event => {
  const button = event.target.closest?.('[data-monitor-sort]');
  if (!button) return;
  const table = button.closest('table'), body = table?.tBodies[0];
  if (!body) return;
  const column = Number(button.dataset.monitorSort);
  const descending = button.dataset.direction !== 'descending';
  table.querySelectorAll('[data-monitor-sort]').forEach(header => { delete header.dataset.direction; });
  button.dataset.direction = descending ? 'descending' : 'ascending';
  const rows = [...body.querySelectorAll('tr[data-monitor-row]')];
  const metas = new Map([...body.querySelectorAll('tr[data-monitor-meta]')].map(row => [row.dataset.monitorMeta, row]));
  rows.sort((a, b) => {
    const av = a.cells[column]?.dataset.sortValue ?? '', bv = b.cells[column]?.dataset.sortValue ?? '';
    if (!av || !bv) return !av && !bv ? 0 : !av ? 1 : -1;
    const an = Number(av), bn = Number(bv);
    const order = Number.isFinite(an) && Number.isFinite(bn) ? an - bn : av.localeCompare(bv, undefined, { numeric: true });
    return descending ? -order : order;
  });
  for (const row of rows) { body.append(row); const meta = metas.get(row.dataset.monitorRow); if (meta) body.append(meta); }
});
