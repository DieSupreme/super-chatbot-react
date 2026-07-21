// One GPU, two heavyweight backends. Forge and ComfyUI must never run at the
// same time — they fight over VRAM. Each backend registers a stopper and a
// busy probe; claim(name) refuses while another backend is mid-generation
// (never silently kill an in-flight job) and otherwise stops the others.
const backends = {};

function register(name, { stop, isBusy, isRunning }) {
  backends[name] = { stop, isBusy, isRunning };
}

async function doClaim(name) {
  for (const [other, b] of Object.entries(backends)) {
    if (other === name) continue;
    if (b.isBusy && b.isBusy()) {
      throw new Error(`${other} is mid-generation — wait for it to finish or stop it first`);
    }
  }
  for (const [other, b] of Object.entries(backends)) {
    if (other === name) continue;
    if (b.isRunning && b.isRunning()) {
      const r = await b.stop();
      // A stop that couldn't actually take the other backend down (e.g. it was
      // started outside this app) or that left its port occupied must FAIL the
      // claim — otherwise both backends run and fight over VRAM.
      if (r && r.ok === false) {
        throw new Error(r.error || `${other} is running and could not be stopped — stop it manually first`);
      }
      if (r && r.portFree === false) {
        throw new Error(`${other} was stopped but its port is still in use — try again in a moment`);
      }
    }
  }
}

// Serialize claims through a single in-flight chain: two near-simultaneous
// Start clicks can otherwise interleave across a stop()'s await and both spawn.
// Throws with a user-facing message if another backend is mid-generation or
// couldn't be stopped; otherwise resolves once the others are down.
let chain = Promise.resolve();
function claim(name) {
  const run = chain.then(() => doClaim(name));
  chain = run.catch(() => {});   // keep the chain alive regardless of outcome
  return run;
}

module.exports = { register, claim };
