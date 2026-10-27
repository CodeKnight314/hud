import type { ProgramSpec } from './types.ts';

export const MANAGEMENT_OPERATIONS = ['create', 'update', 'push', 'remove', 'restore', 'purge', 'createBoard', 'setBoard', 'clearBoard', 'deleteBoard', 'organize', 'annotate', 'compare', 'ackAlerts', 'reviewAttention', 'link', 'unlink', 'comment', 'ask', 'decide', 'finish', 'run', 'importState', 'exportState', 'backup', 'watch', 'shutdown'] as const;
const obj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
function invalid(message: string): never { throw Object.assign(new Error(message), { status: 400 }); }

export function cleanProgram(value: unknown): ProgramSpec {
  if (!obj(value) || typeof value.code !== 'string' || !value.code.trim()) invalid('program requires nonempty code');
  let code = value.code.trim();
  let language = value.language ?? 'html';
  const fenced = /^```(html|javascript|js|svg)?\s*\n([\s\S]*?)\n```$/.exec(code);
  if (fenced) { code = fenced[2]!; language = value.language ?? (fenced[1] === 'js' ? 'javascript' : fenced[1] || 'html'); }
  if (!['html', 'javascript', 'svg'].includes(language)) invalid('program language must be html|javascript|svg');
  if (Buffer.byteLength(code) > 1_048_576) invalid('program code exceeds 1 MiB');
  if (typeof value.description !== 'string' || !value.description.trim() || value.description.length > 2000) invalid('program requires a description of at most 2000 characters');
  const bindings = value.bindings ?? [], capabilities = value.capabilities ?? [];
  if (!Array.isArray(bindings) || bindings.length > 200 || bindings.some(b => typeof b !== 'string' || !/^[\w.-]{1,64}$/.test(b))) invalid('bindings must contain at most 200 monitor ids');
  if (!Array.isArray(capabilities) || capabilities.length > 100) invalid('capabilities must be an array of at most 100 grants');
  for (const c of capabilities) if (!obj(c) || !MANAGEMENT_OPERATIONS.includes(c.operation) || typeof c.scope !== 'string' || (c.scope !== '*' && !/^[\w.-]{1,64}$/.test(c.scope))) invalid('each grant requires a named supported operation and board scope (or explicit *)');
  return { code, language, description: value.description, bindings: [...new Set(bindings)], capabilities: capabilities.map(c => ({ operation: c.operation, scope: c.scope })) };
}

const safeJSON = (data: unknown) => JSON.stringify(data).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
export const PROGRAM_CSP = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'self'";

export function programDocument(program: ProgramSpec, session: string, initialData: unknown): string {
  const bootstrap = `(() => {
    const token=${safeJSON(session)}, dataListeners=new Set(),resizeListeners=new Set(),disposeListeners=new Set(),pending=new Map(),outbox=[];let sequence=0,port;
    const send=(kind,extra={})=>{const message={hudProgram:token,kind,...extra};if(port)port.postMessage(message);else outbox.push(message)};
    const hud=window.hud={data:${safeJSON(initialData)},size:{width:innerWidth,height:innerHeight},theme:{background:'#0e1218',foreground:'#e6ebf2',muted:'#9aa6b6',accent:'#8eb0ff',red:'#ff6d6d',green:'#3dcc7a',font:'Inter, ui-sans-serif, system-ui, sans-serif'},
      onData(fn){dataListeners.add(fn);return()=>dataListeners.delete(fn)},onResize(fn){resizeListeners.add(fn);return()=>resizeListeners.delete(fn)},onDispose(fn){disposeListeners.add(fn)},
      rendered(){requestAnimationFrame(()=>requestAnimationFrame(()=>send('rendered',{nonempty:!!document.body&&(!!document.body.textContent.trim()||!!document.querySelector('svg,canvas,img,input,button'))})))},
      error(message){send('error',{message:String(message).slice(0,2000)})},
      action(operation,args={}){const id=++sequence;send('action',{id,operation,args});return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(new Error('action timed out'))},30000);pending.set(id,{resolve,reject,timer})})}
    };
    const receive=m=>{if(m.kind==='data'){hud.data=m.data;for(const fn of dataListeners)try{fn(hud.data)}catch(e){hud.error(e.message)}}if(m.kind==='result'){const p=pending.get(m.id);if(p){clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(new Error(m.error)):p.resolve(m.result)}}};
    addEventListener('message',event=>{if(port||event.source!==parent||event.data?.hudProgram!==token||event.data.kind!=='connect'||!event.ports[0])return;port=event.ports[0];port.onmessage=event=>receive(event.data);port.start();for(const message of outbox.splice(0))port.postMessage(message)});
    addEventListener('resize',()=>{hud.size={width:innerWidth,height:innerHeight};for(const fn of resizeListeners)try{fn(hud.size)}catch(e){hud.error(e.message)}});
    addEventListener('pagehide',()=>{for(const fn of disposeListeners)try{fn()}catch{}port?.close()});
    addEventListener('error',event=>hud.error(event.message||'program error'));
    addEventListener('unhandledrejection',event=>hud.error(event.reason?.message||String(event.reason)));
    addEventListener('load',()=>hud.rendered());
    parent.postMessage({hudProgram:token,kind:'ready'},'*');
  })();`;
  const content = program.language === 'javascript' ? `<script>${program.code.replace(/<\/script/gi, '<\\/script')}</script>` : program.code;
  return `<!doctype html><html><head><meta charset="utf-8"><style>:root{color-scheme:dark;--fg:#e6ebf2;--bg:#0e1218;--muted:#9aa6b6;--line:rgba(232,238,248,.16);--red:#ff6d6d;--green:#3dcc7a;--accent:#8eb0ff}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 Inter,ui-sans-serif,system-ui,sans-serif;width:100vw;height:100vh;min-height:100vh;overflow:auto}svg,canvas{max-width:100%}button,input,select{font:inherit;color:inherit;background:#1b212b;border:1px solid var(--line);border-radius:6px;padding:4px 8px}</style><script>${bootstrap}</script></head><body>${content}</body></html>`;
}
