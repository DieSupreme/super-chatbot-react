// One GPU, two heavyweight backends. Forge and ComfyUI must never run at the
// same time — they fight over VRAM. Each backend registers a stopper and a
// busy probe; claim(name) refuses while another backend is mid-generation
// (never silently kill an in-flight job) and otherwise stops the others.
const backends = {};

function register(name, { stop, isBusy, isRunning }) {
  backends[name] = { stop, isBusy, isRunning };
}

// Throws with a user-facing message if another backend is mid-generation.
// Otherwise stops every other running backend and resolves when they're down.
async function claim(name) {
  for (const [other, b] of Object.entries(backends)) {
    if (other === name) continue;
    if (b.isBusy && b.isBusy()) {
      throw new Error(`${other} is mid-generation — wait for it to finish or stop it first`);
    }
  }
  for (const [other, b] of Object.entries(backends)) {
    if (other === name) continue;
    if (b.isRunning && b.isRunning()) await b.stop();
  }
}

module.exports = { register, claim };
