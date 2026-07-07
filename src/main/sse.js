// Pure SSE line parsing for OpenRouter chat streaming (testable without Electron).

function createSseState() {
  const state = { full: '', usage: null, citations: [] };
  state.processLine = (line) => {
    const t = line.trim();
    if (!t.startsWith('data:')) return;
    const data = t.slice(5).trim();
    if (data === '[DONE]') return;
    try {
      const json = JSON.parse(data);
      const d = json.choices?.[0]?.delta || {};
      if (d.content) state.full += d.content;
      const anns = d.annotations || json.choices?.[0]?.message?.annotations;
      if (Array.isArray(anns)) {
        for (const a of anns) {
          if (a.type === 'url_citation' && a.url_citation) {
            const u = a.url_citation.url;
            if (u && !state.citations.find(c => c.url === u)) {
              state.citations.push({ url: u, title: a.url_citation.title || u });
            }
          }
        }
      }
      if (json.usage) state.usage = json.usage;
    } catch (_) {}
  };
  return state;
}

function drainSseBuffer(buf, consumeAll, processLine) {
  const lines = buf.split('\n');
  const rest = consumeAll ? '' : (lines.pop() ?? '');
  for (const line of lines) processLine(line);
  return rest;
}

module.exports = { createSseState, drainSseBuffer };
