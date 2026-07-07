// Minimal node-pty stand-in for tests: no native binary, deterministic.
// spawn() returns a proc that echoes writes as data, emits a banner on next tick,
// and fires exit when killed.
function spawn(shell, args, opts) {
  const dataCbs = [];
  const exitCbs = [];
  let killed = false;
  const emit = (d) => { if (!killed) for (const cb of dataCbs.slice()) cb(d); };
  const doExit = () => {
    if (killed) return;
    killed = true;
    for (const cb of exitCbs.slice()) cb({ exitCode: 0, signal: 0 });
  };
  setImmediate(() => emit('BANNER(' + shell + ')@' + ((opts && opts.cwd) || '') + '\n'));
  const autoExitMs = Number(process.env.TERM_FAKE_AUTOEXIT);
  if (Number.isFinite(autoExitMs) && autoExitMs > 0) {
    const t = setTimeout(doExit, autoExitMs);
    if (t.unref) t.unref();
  }
  return {
    onData(cb) { dataCbs.push(cb); return { dispose() {} }; },
    onExit(cb) { exitCbs.push(cb); return { dispose() {} }; },
    write(d) { emit('ECHO:' + d); },
    resize() {},
    kill() { doExit(); }
  };
}
module.exports = { spawn };
