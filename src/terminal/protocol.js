// Wire protocol + path helpers shared by the terminal daemon and its client.
// Pure functions only (no sockets, no fs writes) so they unit-test without I/O.
// Framing is newline-delimited JSON; PTY bytes ride inside messages as base64.
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// A stable per-user tag so the app and a previously-spawned daemon agree on the
// pipe without a rendezvous file. TERM_PIPE_NAME overrides it (tests use a unique
// tag so they never collide with a real running daemon).
function userTag() {
  if (process.env.TERM_PIPE_NAME) return process.env.TERM_PIPE_NAME;
  const h = crypto.createHash('sha1').update(os.userInfo().username + '|' + os.homedir()).digest('hex').slice(0, 12);
  return 'superchat-term-' + h;
}

// Named pipe on Windows; unix-domain socket path elsewhere.
function pipePath() {
  const tag = userTag();
  if (process.platform === 'win32') return '\\\\.\\pipe\\' + tag;
  return path.join(os.tmpdir(), tag + '.sock');
}

function lockfilePath(userDataDir) {
  return path.join(userDataDir, 'terminal-daemon.json');
}

function makeToken() {
  return crypto.randomBytes(24).toString('hex');
}

function encodeMessage(obj) {
  return JSON.stringify(obj) + '\n';
}

// Returns a feed(chunk) function; invokes onMessage for each complete line.
// Tolerates partial chunks, blank lines, and malformed JSON (skips the latter).
function createDecoder(onMessage) {
  let buf = '';
  return (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (_) { continue; }
      onMessage(msg);
    }
  };
}

module.exports = { pipePath, lockfilePath, makeToken, encodeMessage, createDecoder };
