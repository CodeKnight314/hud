# probes

A probe is a TypeScript (or JS) module that links a monitor to anything: a process, a log file, an API, a queue.
Point a monitor at it with `source: { kind: "probe", probe: "<file name without .ts>", config: {...}, interval: 30 }`
(or an absolute path to a module elsewhere). Node runs `.ts` directly — no build step.

```ts
export const interval = 10;                       // optional default poll interval (seconds)

// polled: return a reading
export default async function (ctx) {
  return { value: 42, unit: 'ms', state: 'ok', message: 'all good', progress: 50 };
}

// or/and streaming: keep a link open and emit readings whenever you like
export async function watch(ctx) {
  const timer = setInterval(() => ctx.emit({ value: Math.random() }), 1000);
  return () => clearInterval(timer);              // called when the monitor is changed or deleted
}
```

`ctx` = `{ config, item, signal, emit(reading), log(...) }`. Throwing (or rejecting) marks the monitor `error` with the message.
`ctx.signal` is aborted when a poll times out or the monitor is changed/deleted; pass it to `fetch`, `spawn`, sockets.
A probe that fails to load (missing, syntax error) or whose `watch` throws is retried every interval, so fixing the file
is enough. Edits are picked up on the next poll. A successfully started `watch` keeps running until the monitor changes.
Always attach an `'error'` listener to child processes and sockets you create; an unhandled one is a bug in the probe.

Included:
- `tail` follow a log file (needs `tail`, POSIX only) `{file, errorPattern?, warnPattern?}`
- `process` is a process running (needs `pgrep`, POSIX only)
- `git` dirty files / branch
- `tcp` port open? `{host, port}` (value = connect ms)
- `tls` certificate expiry `{host, port?=443, warnDays?=14, errorDays?=3}` (value = days left)
- `dns` name resolves `{name, type?='A'}` (value = lookup ms)
- `disk` filesystem use `{path?='/'}` (value = % used; set warnAbove/errorAbove on the monitor)
- `file-age` seconds since mtime `{path, warnAfter?, errorAfter?}`
