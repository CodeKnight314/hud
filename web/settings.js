(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const tabs = [...document.querySelectorAll('[role="tab"][data-tab]')];
  let appState = null, bridgeAvailable = false, mutationBusy = '', externalBusy = '', pendingCheck = null;
  let busyClientId = '', activeTab = 'connections', updatePollTimer = null, updatePollCount = 0, updatePollStopped = false;
  const method = (name) => { const api = window.hudSettings; return typeof api?.[name] === 'function' ? api[name].bind(api) : null; };
  const el = (tag, cls = '', text = '') => { const item = document.createElement(tag); if (cls) item.className = cls; item.textContent = text; return item; };
  const messageOf = (error, fallback) => error?.message?.trim?.() || (typeof error === 'string' && error.trim()) || fallback;
  function feedback(text, kind = '') { const item = $('action-status'); item.textContent = text; item.className = `action-status${kind ? ` ${kind}` : ''}`; item.hidden = !text; }

  function setTab(name, focus = false) {
    const changed = activeTab !== name;
    activeTab = name;
    for (const tab of tabs) {
      const selected = tab.dataset.tab === name;
      tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1;
      tab.classList.toggle('selected', selected); $(`panel-${tab.dataset.tab}`).hidden = !selected;
    }
    $('settings-context').textContent = name === 'updates' ? 'Updates' : name === 'templates' ? 'Templates' : 'Connections';
    if (focus) tabs.find((tab) => tab.dataset.tab === name)?.focus();
    if (changed && name === 'updates' && bridgeAvailable && !mutationBusy) void refreshState('getState', 'Refreshing update status…');
  }

  function setState(state) {
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('The desktop app returned an invalid settings state.');
    appState = state; $('load-status').textContent = 'Ready'; $('load-error').hidden = true;
    $('platform-name').textContent = state.platformName || 'Desktop app'; $('app-version').textContent = state.version ? `Version ${state.version}` : '';
    render(); scheduleUpdatePoll();
  }

  function scheduleUpdatePoll() {
    if (appState?.updates?.status !== 'checking') {
      clearTimeout(updatePollTimer); updatePollTimer = null; updatePollCount = 0; updatePollStopped = false;
    } else if (!updatePollTimer && !updatePollStopped && updatePollCount < 40) {
      updatePollTimer = setTimeout(pollUpdateState, 750);
    }
  }

  async function pollUpdateState() {
    updatePollTimer = null;
    if (!bridgeAvailable || appState?.updates?.status !== 'checking' || mutationBusy || externalBusy) return scheduleUpdatePoll();
    const getState = method('getState'); if (!getState) return;
    mutationBusy = 'updatePoll'; render();
    try {
      updatePollCount++;
      setState(await getState());
      if (appState?.updates?.status === 'checking' && updatePollCount >= 40) {
        updatePollStopped = true; feedback('The update check is taking longer than expected. Select Updates or check again shortly.');
      }
    } catch (error) {
      feedback(messageOf(error, 'Could not refresh update status.'), 'bad');
      if (updatePollCount >= 40) updatePollStopped = true;
    } finally {
      mutationBusy = ''; render(); scheduleUpdatePoll();
    }
  }

  function registration(c) { return c.registered === true || c.state === 'connected' || c.state === 'needs-repair'; }
  function connectionStatus(c) {
    const registered = registration(c);
    if (c.state === 'error') return { glyph: '✕', text: registered ? 'Error · registered' : 'Error', cls: 'bad' };
    if (c.state === 'needs-repair') return { glyph: '▲', text: 'Needs repair · registered' };
    if (registered) return { glyph: '●', text: 'Registered' };
    if (c.state === 'unavailable' || !c.detected) return { glyph: '○', text: 'Unavailable' };
    return { glyph: '○', text: 'Not registered' };
  }
  function symbol(c) {
    const id = `${c.id || ''} ${c.label || ''}`.toLowerCase();
    return id.includes('claude') ? '*' : id.includes('codex') ? '>_' : id.includes('opencode') ? '◧' : '●';
  }
  function clientActions(c) {
    const registered = registration(c);
    if (c.state === 'unavailable' || !c.detected) return registered ? [{ action: 'disconnect', text: 'Disconnect' }] : [];
    if (registered) return [{ action: 'connect', text: 'Repair' }, { action: 'disconnect', text: 'Disconnect' }];
    if (c.state === 'error') return [{ action: 'connect', text: 'Repair' }];
    return c.state === 'not-connected' ? [{ action: 'connect', text: 'Connect' }] : [];
  }

  async function mutate(name, args, progress, done) {
    const run = method(name);
    if (!run || mutationBusy || externalBusy) { if (!run) feedback('This action is unavailable in the current desktop app.', 'bad'); return null; }
    mutationBusy = name; feedback(progress); render();
    try {
      const state = await run(...args);
      setState(state);
      const result = typeof done === 'function' ? done(state) : done || 'Settings updated.';
      if (result && typeof result === 'object') feedback(result.text, result.kind || ''); else feedback(result);
      return state;
    } catch (error) {
      feedback(messageOf(error, 'Could not complete the requested action.'), 'bad');
      return null;
    } finally {
      mutationBusy = ''; render();
    }
  }

  async function external(name, progress, done, args = []) {
    const run = method(name);
    if (!run || mutationBusy || externalBusy) { if (!run) feedback('This action is unavailable in the current desktop app.', 'bad'); return; }
    externalBusy = name; feedback(progress); render();
    try { await run(...args); feedback(done); }
    catch (error) { feedback(messageOf(error, `Could not complete ${name}.`), 'bad'); }
    finally { externalBusy = ''; render(); }
  }

  async function clientAction(c, action) {
    const label = String(c.label || c.id || 'client');
    busyClientId = c.id;
    await mutate(action.action, [c.id], `${action.text} ${label}…`, (state) => {
      const updated = state.connections?.find((item) => item.id === c.id);
      if (action.action === 'disconnect') {
        if (updated && updated.registered !== true && !['connected', 'needs-repair'].includes(updated.state)) return `HUD registration removed from ${label}. Restart the client to reload its configuration.`;
        return updated?.state === 'error' ? { text: updated.detail || `Could not disconnect ${label}.`, kind: 'bad' } : updated?.detail || `HUD could not confirm that ${label} was disconnected.`;
      }
      if (updated?.state === 'connected') return `HUD registered with ${label}. Restart the client to load its configuration.`;
      return updated?.state === 'error' ? { text: updated.detail || `Could not register ${label}.`, kind: 'bad' } : updated?.detail || `HUD could not confirm registration with ${label}.`;
    });
    busyClientId = ''; renderConnections();
  }

  function renderConnections() {
    const list = $('connection-list'), connections = Array.isArray(appState?.connections) ? appState.connections : [];
    list.replaceChildren();
    $('connections-empty').hidden = !appState || connections.length > 0;
    for (const c of connections) {
      const label = String(c.label || c.id || 'Command-line client'), row = el('article', 'connection-row');
      row.setAttribute('role', 'listitem');
      const main = el('div', 'connection-main'), head = el('div', 'connection-head'), mark = el('span', 'cli-symbol', symbol(c));
      mark.setAttribute('aria-hidden', 'true'); head.append(mark, el('strong', 'client-name', label));
      const status = connectionStatus(c), meta = el('div', 'connection-meta');
      const detected = c.state !== 'unavailable' && Boolean(c.detected), glyph = el('span', '', status.glyph);
      glyph.setAttribute('aria-hidden', 'true');
      meta.append(el('span', '', detected ? '● CLI detected' : '○ CLI not found'), glyph, el('span', status.cls || '', status.text));
      main.append(head, meta);
      const detail = String(c.detail || (c.state === 'unavailable' ? 'CLI not found. Install it, then refresh.' : c.state === 'not-connected' ? 'Register HUD to make its tools available.' : ''));
      if (detail) main.append(el('small', 'connection-detail', detail));
      if (c.configPath) main.append(el('small', 'config-path', `Config · ${c.configPath}`));
      const actions = el('div', 'row-actions'), specs = clientActions(c);
      for (const action of specs) {
        const button = el('button', `button${c.state !== 'connected' && ['Repair', 'Connect'].includes(action.text) ? ' primary' : ''}`, action.text);
        button.type = 'button'; button.setAttribute('aria-label', `${action.text} ${label}`);
        button.disabled = !bridgeAvailable || Boolean(mutationBusy || externalBusy) || !method(action.action);
        if (mutationBusy && busyClientId === c.id) button.textContent = action.action === 'disconnect' ? 'Disconnecting…' : action.text === 'Repair' ? 'Repairing…' : 'Connecting…';
        button.addEventListener('click', () => clientAction(c, action)); actions.append(button);
      }
      if (!specs.length && (c.state === 'unavailable' || !c.detected)) actions.append(el('small', 'dim', 'Install the CLI to connect'));
      row.append(main, actions); list.append(row);
    }
    $('refresh-connections').disabled = !bridgeAvailable || Boolean(mutationBusy || externalBusy) || !method(appState ? 'refreshConnections' : 'getState');
    $('refresh-connections').textContent = mutationBusy ? 'Refreshing…' : '↻ Refresh';
  }

  function renderCommand() {
    const command = appState?.command || {}, ready = Boolean(command.ready), installed = Boolean(command.installed);
    $('command-glyph').textContent = ready ? '✓' : installed ? '▲' : '○';
    $('command-status').className = `state-label${ready ? ' ok' : ''}`;
    $('command-state-text').textContent = ready ? 'Ready' : installed ? 'Needs repair' : 'Not installed';
    const detail = ready ? 'Available to terminals and MCP clients.' : command.detail || 'Used by HUD connections and terminal workflows.';
    $('command-detail').textContent = ready && command.appImage ? `${detail} Move the AppImage and choose Repair command so the path stays current.` : detail;
    $('command-path').textContent = command.path ? `Path · ${command.path}` : ''; $('command-path').hidden = !command.path;
    const button = $('install-command');
    button.disabled = !bridgeAvailable || !appState || Boolean(mutationBusy || externalBusy) || !method('installCommand');
    button.textContent = mutationBusy === 'installCommand' ? (installed ? 'Repairing…' : 'Installing…') : installed ? 'Repair command' : 'Install command';
    $('copy-config').disabled = !bridgeAvailable || !ready || Boolean(mutationBusy || externalBusy) || !method('copyConfig');
    $('copy-config').textContent = externalBusy === 'copyConfig' ? 'Copying…' : 'Copy configuration';
  }

  function renderUpdates() {
    const u = appState?.updates || {}, status = u.status || 'unchecked';
    const states = { unchecked: ['○', 'Not checked', ''], checking: ['◐', 'Checking', ''], available: ['▲', 'Update available', ''], current: ['✓', 'Up to date', 'ok'], error: ['✕', 'Check failed', 'bad'], unsupported: ['○', 'Not supported', ''] };
    const [glyph, label, cls] = states[status] || states.unchecked;
    $('current-version').textContent = u.currentVersion || appState?.version || '—';
    $('update-glyph').textContent = glyph; $('update-status-text').textContent = label;
    $('update-status-label').className = `state-label${cls ? ` ${cls}` : ''}`;
    $('update-detail').textContent = u.message || ({ unchecked: 'Check for a newer HUD desktop release.', checking: 'Checking for updates…', available: `Version ${u.latestVersion || 'a newer version'} is available.`, current: 'You have the latest supported version.', error: 'The update check failed. Try again later.', unsupported: 'Update checks are not available for this build.' }[status] || 'Check for updates.');
    $('latest-version-row').hidden = !u.latestVersion; $('latest-version').textContent = u.latestVersion || '—';
    const checked = u.checkedAt ? new Date(u.checkedAt).toLocaleString() : '';
    $('checked-at').textContent = checked ? `Last checked ${checked}` : ''; $('checked-at').hidden = !checked;
    $('download-name-row').hidden = !u.downloadName; $('download-name').textContent = u.downloadName || '';
    const busy = Boolean(mutationBusy || externalBusy);
    $('check-updates').disabled = !bridgeAvailable || !appState || busy || status === 'checking' || !method('checkUpdates');
    $('check-updates').textContent = mutationBusy === 'checkUpdates' || status === 'checking' ? 'Checking…' : 'Check for updates';
    $('install-update').disabled = !bridgeAvailable || !appState?.packaged || busy || status !== 'available' || !method('installUpdate');
    $('install-update').textContent = mutationBusy === 'installUpdate' ? 'Downloading…' : 'Install update';
    $('download-update').disabled = !bridgeAvailable || busy || status !== 'available' || !method('downloadUpdate');
    $('download-update').textContent = externalBusy === 'downloadUpdate' ? 'Opening…' : 'Download in browser';
    $('quit-for-update').disabled = !bridgeAvailable || !appState?.packaged || busy || !method('quitForUpdate');
    $('quit-for-update').textContent = externalBusy === 'quitForUpdate' ? 'Quitting…' : 'Quit HUD for update';
    $('open-release').disabled = !bridgeAvailable || busy || !u.releaseUrl || !method('openRelease');
    $('open-release').textContent = externalBusy === 'openRelease' ? 'Opening…' : 'View release';
    $('check-on-launch').disabled = !bridgeAvailable || !appState || busy || !method('setCheckOnLaunch');
    $('check-on-launch').checked = pendingCheck === null ? Boolean(u.checkOnLaunch) : pendingCheck;
    const offer = appState?.reconnect, pending = Boolean(offer?.pending);
    $('reconnect-card').hidden = !pending;
    $('reconnect-detail').textContent = pending ? `Reconnect MCP clients once so they load hud v${offer.serverVersion || appState?.version || ''}.` : 'Reconnect MCP clients once so they load this hud version.';
    $('reconnect-text').textContent = pending ? String(offer.text || '') : '';
    $('reconnect-dismiss').disabled = !bridgeAvailable || !pending || busy || !method('ackReconnect');
    $('reconnect-dismiss').textContent = mutationBusy === 'ackReconnect' ? 'Dismissing…' : 'Dismiss checklist';
  }

  function renderTemplates() {
    const root = $('template-list');
    const empty = $('templates-empty');
    if (!root || !empty) return;
    const templates = Array.isArray(appState?.templates) ? appState.templates : [];
    root.replaceChildren();
    empty.hidden = templates.length > 0;
    const busy = Boolean(mutationBusy || externalBusy) || !bridgeAvailable || !method('openTemplateDocs');
    for (const template of templates) {
      if (!template || typeof template !== 'object') continue;
      const card = el('article', 'template-card');
      card.setAttribute('role', 'listitem');
      card.dataset.template = String(template.id || '');
      const title = el('div', 'template-title');
      title.append(el('strong', '', String(template.id || 'template')), el('span', '', String(template.title || '')));
      card.append(title);
      if (template.summary) card.append(el('p', 'template-summary', String(template.summary)));
      const defaults = el('pre', 'template-defaults');
      defaults.textContent = String(template.defaultsText || '');
      card.append(defaults);
      if (Array.isArray(template.required) && template.required.length) card.append(el('p', 'template-required', `required: ${template.required.join(', ')}`));
      if (template.command) card.append(el('p', 'template-command', String(template.command)));
      if (typeof template.docs === 'string' && template.docs) {
        const link = el('button', 'text-button template-docs', template.docs);
        link.type = 'button';
        link.dataset.templateDocs = String(template.id || '');
        link.setAttribute('aria-label', `Open ${template.docs}`);
        link.disabled = busy;
        card.append(link);
      }
      root.append(card);
    }
  }

  function render() { renderConnections(); renderCommand(); renderUpdates(); renderTemplates(); }

  async function refreshState(name, progress) {
    const run = method(name);
    if (!run || mutationBusy || externalBusy) return;
    mutationBusy = name;
    updatePollCount = 0; updatePollStopped = false; feedback(progress); render();
    try {
      setState(await run()); feedback(name === 'getState' ? 'Settings refreshed.' : 'Connection status refreshed.');
    } catch (error) {
      const message = messageOf(error, 'Could not refresh settings.');
      if (!appState) { $('load-status').textContent = 'Settings unavailable'; $('load-error').textContent = message; $('load-error').hidden = false; }
      feedback(message, 'bad');
    } finally { mutationBusy = ''; render(); scheduleUpdatePoll(); }
  }

  async function savePreference() {
    pendingCheck = $('check-on-launch').checked;
    const wanted = pendingCheck;
    const state = await mutate('setCheckOnLaunch', [wanted], 'Saving update preference…', (next) =>
      Boolean(next.updates?.checkOnLaunch) === wanted ? 'Update preference saved.' : 'The app did not confirm this preference.');
    if (!state) pendingCheck = null;
    renderUpdates();
  }

  for (const tab of tabs) {
    tab.addEventListener('click', () => setTab(tab.dataset.tab));
    tab.addEventListener('keydown', (event) => {
      const horizontal = $('settings-tabs').getAttribute('aria-orientation') === 'horizontal';
      const key = horizontal ? (event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0) : (event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0);
      const index = tabs.indexOf(tab), next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : key ? (index + key + tabs.length) % tabs.length : -1;
      if (next >= 0) { event.preventDefault(); setTab(tabs[next].dataset.tab, true); }
    });
  }
  $('refresh-connections').addEventListener('click', () => refreshState(appState ? 'refreshConnections' : 'getState', 'Refreshing connections…'));
  $('install-command').addEventListener('click', () => mutate('installCommand', [], 'Installing or repairing the HUD command…', (s) => s.command?.ready ? 'The HUD command is ready.' : s.command?.detail || 'The HUD command needs attention.'));
  $('copy-config').addEventListener('click', () => external('copyConfig', 'Copying MCP configuration…', 'MCP configuration copied.'));
  $('check-updates').addEventListener('click', () => mutate('checkUpdates', [], 'Checking for updates…', (s) => s.updates?.status === 'error' ? { text: s.updates.message || 'The update check failed.', kind: 'bad' } : s.updates?.message || 'Update status refreshed.'));
  $('install-update').addEventListener('click', () => mutate('installUpdate', [], 'Downloading the installer and checking SHA256…', (s) => {
    if (s.updateApply === 'started') return 'SHA256 matched. HUD is quitting to install and relaunch.';
    if (s.updateApply === 'cancelled') return 'Update left uninstalled.';
    return { text: 'HUD did not confirm the update.', kind: 'bad' };
  }));
  $('download-update').addEventListener('click', () => external('downloadUpdate', 'Opening installer download…', 'Opened the installer download in your browser.'));
  $('quit-for-update').addEventListener('click', () => external('quitForUpdate', 'Saving boards and quitting HUD…', 'HUD is quitting for the update.'));
  $('open-release').addEventListener('click', () => external('openRelease', 'Opening release information…', 'Opened release information in your browser.'));
  $('template-list').addEventListener('click', (event) => {
    const button = event.target.closest('[data-template-docs]');
    if (!button) return;
    external('openTemplateDocs', 'Opening the guide…', `Opened ${button.textContent}.`, [button.dataset.templateDocs]);
  });
  $('check-on-launch').addEventListener('change', savePreference);
  $('reconnect-dismiss').addEventListener('click', () => mutate('ackReconnect', [], 'Dismissing the reconnect checklist…', (s) => s.reconnect?.pending ? { text: 'The reconnect checklist is still pending.', kind: 'bad' } : 'Reconnect checklist dismissed.'));
  function syncTabOrientation() { $('settings-tabs').setAttribute('aria-orientation', matchMedia('(max-width: 760px)').matches ? 'horizontal' : 'vertical'); }
  window.addEventListener('resize', syncTabOrientation, { passive: true });
  window.addEventListener('beforeunload', () => clearTimeout(updatePollTimer), { once: true });
  syncTabOrientation();

  async function boot() {
    const getState = method('getState');
    if (!getState) {
      $('bridge-fallback').hidden = false;
      $('platform-name').textContent = 'Desktop app required';
      $('load-status').textContent = 'Desktop bridge unavailable';
      return;
    }
    bridgeAvailable = true;
    mutationBusy = 'getState';
    render();
    try { setState(await getState()); }
    catch (error) {
      $('load-status').textContent = 'Settings unavailable';
      $('load-error').textContent = messageOf(error, 'Could not load desktop settings.');
      $('load-error').hidden = false;
      render();
    } finally { mutationBusy = ''; render(); scheduleUpdatePoll(); }
  }
  void boot();
})();
