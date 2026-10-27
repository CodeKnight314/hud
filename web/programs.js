const mounted = new Map();
async function request(path, body, method = 'POST') {
  const response = await fetch(path, { method, headers: { 'content-type': 'application/json', 'x-hud-actor': 'user' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

export function mountSession(element, session) {
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.setAttribute('title', session.description || 'custom HUD program');
  frame.style.cssText = 'width:100%;height:100%;border:0;display:block;background:#0e1218';
  const errors = [];
  let finished = false, resolveReady, connected = false, loads = 0, timer = null, disposed = false;
  const channel = new MessageChannel();
  const ready = new Promise(resolve => { resolveReady = resolve; });
  const finish = () => { if (finished) return; finished = true; clearTimeout(timeout); resolveReady({ errors }); };
  const release = () => {
    if (timer) clearInterval(timer);
    timer = null;
    fetch(`/api/program-sessions/${encodeURIComponent(session.sessionId)}`, { method: 'DELETE' }).catch(() => {});
  };
  const timeout = setTimeout(() => { const message = 'Custom program did not render nonempty content within 10 seconds.'; errors.push(message); dispose(); element.textContent = message; }, 10000);
  const handler = event => {
    if (connected || event.source !== frame.contentWindow || event.origin !== 'null' || event.data?.hudProgram !== session.sessionId || event.data.kind !== 'ready') return;
    connected = true;
    frame.contentWindow.postMessage({ hudProgram: session.sessionId, kind: 'connect' }, '*', [channel.port2]);
  };
  channel.port1.onmessage = async event => {
    if (disposed || event.data?.hudProgram !== session.sessionId) return;
    const message = event.data;
    if (message.kind === 'rendered' && message.nonempty) finish();
    if (message.kind === 'error') { const error = String(message.message).slice(0, 2000); errors.push(error); dispose(); element.textContent = `Custom program: ${error}`; }
    if (message.kind === 'action') {
      try {
        if (session.readonly) throw new Error('Actions are disabled during preview and capture.');
        const result = await request(`/api/program-sessions/${encodeURIComponent(session.sessionId)}/action`, { operation: message.operation, args: message.args });
        channel.port1.postMessage({ hudProgram: session.sessionId, kind: 'result', id: message.id, result });
      } catch (error) {
        channel.port1.postMessage({ hudProgram: session.sessionId, kind: 'result', id: message.id, error: error.message });
      }
    }
  };
  channel.port1.start();
  window.addEventListener('message', handler);
  frame.addEventListener('load', () => { if (++loads > 1) { errors.push('Custom program navigation ended its session.'); dispose(); } });
  frame.src = session.frameUrl;
  element.replaceChildren(frame);
  const refresh = async () => {
    try {
      const response = await fetch(`/api/program-sessions/${encodeURIComponent(session.sessionId)}/data`);
      if (!response.ok) throw new Error('Program session expired or its revision changed.');
      const data = await response.json();
      channel.port1.postMessage({ hudProgram: session.sessionId, kind: 'data', data });
    } catch (error) {
      if (errors.length < 20) errors.push(error.message);
      dispose(); element.textContent = `Custom program: ${error.message}`;
    }
  };
  timer = session.readonly ? null : setInterval(refresh, 5000);
  const dispose = () => {
    if (disposed) return; disposed = true;
    clearTimeout(timeout); release();
    window.removeEventListener('message', handler);
    channel.port1.close(); channel.port2.close();
    frame.remove(); finish();
  };
  return { ready, dispose };
}

export async function mountPrograms(root, options = {}) {
  const nodes = [...root.querySelectorAll('.hud-program')];
  if (root.matches?.('.hud-program')) nodes.unshift(root);
  const jobs = [];
  for (const [element, value] of mounted) if (!element.isConnected || !nodes.includes(element) && root.contains(element)) { value.dispose(); mounted.delete(element); }
  for (const element of nodes) {
    if (mounted.has(element)) { jobs.push(mounted.get(element).ready); continue; }
    const item = element.dataset.programItem, board = element.dataset.programBoard;
    if (!item && !board) continue;
    const pending = { ready: null, dispose() {} };
    mounted.set(element, pending);
    const promise = (async () => {
      try {
        const session = await request('/api/program-sessions', { scope: item ? 'item' : 'board', id: item || board, readonly: !!options.readonly, captureToken: options.captureToken || new URLSearchParams(location.search).get('capture') || undefined });
        if (!element.isConnected) { fetch(`/api/program-sessions/${encodeURIComponent(session.sessionId)}`, { method: 'DELETE' }).catch(() => {}); mounted.delete(element); return { errors: [] }; }
        const instance = mountSession(element, session);
        mounted.set(element, instance);
        return await instance.ready;
      } catch (error) {
        if (mounted.get(element) === pending) mounted.delete(element);
        element.textContent = `Custom program: ${error.message}`;
        return { errors: [error.message] };
      }
    })();
    pending.ready = promise;
    jobs.push(promise);
  }
  const reports = await Promise.all(jobs);
  return { errors: reports.flatMap(report => report?.errors || []) };
}

export function disposePrograms(root = document) {
  for (const [element, value] of mounted) if (!element.isConnected || root === element || root.contains(element)) { value.dispose(); mounted.delete(element); }
}
