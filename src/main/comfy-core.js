// Electron-free core for the ComfyUI (video) backend: portable-install layout
// detection, process spawn, workflow loading + manifest-driven patching, a
// minimal WebSocket client (Electron 33 main = Node 20.18, no global
// WebSocket; node builtins only), and output file naming. Mirrors sd-core.js
// so node --test can exercise everything without Electron.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');

// ---------- install layout ----------
// Portable build: <root>\python_embeded\python.exe + <root>\ComfyUI\main.py.
// A git clone (no embedded python) gets base = root and python from PATH.
function detectComfyLayout(root) {
  const embedded = path.join(root, 'python_embeded', 'python.exe');
  const portable = fs.existsSync(embedded) && fs.existsSync(path.join(root, 'ComfyUI', 'main.py'));
  return {
    root,
    portable,
    base: portable ? path.join(root, 'ComfyUI') : root,
    python: portable ? embedded : 'python'
  };
}

// Spawn mirrors run_nvidia_gpu.bat plus --disable-auto-launch and
// --preview-method auto (sampler preview frames over /ws — taesd when its
// models exist, latent2rgb otherwise, so it can never break startup); cwd
// must be the install root (the portable build resolves everything relative
// to it). Args split out for tests — spawnComfy launches a real process.
function comfyArgs(layout, port) {
  const args = ['-s', path.join('ComfyUI', 'main.py'), '--windows-standalone-build',
    '--disable-auto-launch', '--preview-method', 'auto'];
  if (!layout.portable) args.splice(0, 2, path.join(layout.base, 'main.py'));
  if (port && Number(port) !== 8188) args.push('--port', String(port));
  return args;
}

function spawnComfy(root, port) {
  const layout = detectComfyLayout(root);
  return spawn(layout.python, comfyArgs(layout, port), {
    cwd: layout.root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  });
}

// ---------- workflows are data ----------
// A workflow is a PAIR in workflowsDir: <name>.json (ComfyUI API format) and
// <name>.manifest.json (control -> node/input mapping). Adding a model is a
// data drop, never a code change. `media` says what the workflow produces
// ('image' | 'video'); manifests written before the field existed are video.
function workflowMedia(manifest) {
  return manifest && manifest.media === 'image' ? 'image' : 'video';
}

function listWorkflows(dir) {
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch (_) { return []; }
  const ov = readControlOverrides(dir).overrides;   // user shown/hidden + labels, layered at read time
  const out = [];
  for (const f of entries) {
    if (!f.endsWith('.manifest.json')) continue;
    const name = f.slice(0, -'.manifest.json'.length);
    const graphFile = path.join(dir, name + '.json');
    if (!fs.existsSync(graphFile)) continue;
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (manifest.error) continue;   // generation failed — logged there, hidden here
      const generated = !!manifest.generated;
      out.push({
        name, label: manifest.label || name, media: workflowMedia(manifest), generated,
        // hand-authored manifests are exempt from the override mechanism
        controls: generated ? applyControlOverrides(manifest.controls || {}, ov[name]) : (manifest.controls || {})
      });
    } catch (_) { /* malformed manifest -> skipped, surfaced by absence */ }
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

function loadWorkflow(dir, name) {
  const graph = JSON.parse(fs.readFileSync(path.join(dir, name + '.json'), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, name + '.manifest.json'), 'utf8'));
  return { graph, manifest };
}

// Patch ONLY manifest-mapped inputs into a deep copy of the graph. A control
// is either { node, input } or { targets: [{ node, input }, ...] }.
// Readonly controls always patch their manifest default — the value is a
// model constraint (e.g. a distilled checkpoint's locked cfg), not a choice.
function patchWorkflow(graph, manifest, values) {
  const out = JSON.parse(JSON.stringify(graph));
  for (const [key, ctl] of Object.entries(manifest.controls || {})) {
    let v = ctl.type === 'readonly' && ctl.default != null ? ctl.default : values[key];
    if (v === undefined || v === null || v === '') continue;
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) continue;
      if (ctl.min != null) v = Math.max(ctl.min, v);
      if (ctl.max != null) v = Math.min(ctl.max, v);
      if (ctl.type === 'int' || ctl.type === 'seed') v = Math.round(v);
    }
    const targets = ctl.targets || [{ node: ctl.node, input: ctl.input }];
    for (const t of targets) {
      const node = out[t.node];
      if (!node || !node.inputs) throw new Error(`manifest control "${key}" points at missing node ${t.node}`);
      // dotted path = a key inside an object-valued input (Power Lora slots:
      // "lora_1.lora" swaps the file, leaving on/strength untouched) — but
      // ONLY when the parent really is an object: dynamic widgets carry
      // literal dots in flat names ("resize_type.multiplier")
      const dot = String(t.input).indexOf('.');
      if (dot > 0 && !(t.input in node.inputs)) {
        const parent = node.inputs[t.input.slice(0, dot)];
        if (parent && typeof parent === 'object' && !Array.isArray(parent)) {
          parent[t.input.slice(dot + 1)] = v;
        } else if (parent !== undefined) {
          node.inputs[t.input] = v;   // dotted literal name next to a plain widget
        } else {
          throw new Error(`manifest control "${key}" targets "${t.input}" but node ${t.node} has no ${t.input.slice(0, dot)} object`);
        }
      } else {
        node.inputs[t.input] = v;
      }
    }
  }
  return out;
}

// ---------- fidelity: only patch what the user changed ----------
// The renderer sends its WHOLE control state (manifest defaults + draft +
// edits). Patching all of it would rewrite every mapped input with values
// captured at scan time — any skew between manifest and file (or a stale
// draft) silently changes the graph. Dropping entries strictly equal to the
// control's manifest default means untouched widgets pass through the
// workflow file byte-identical. Controls without a default (prompt, seed)
// always pass; readonly controls are patched from the manifest by
// patchWorkflow regardless of what's sent, so dropping them here is safe.
function pruneUnchangedValues(vals, controls) {
  const out = {};
  for (const [k, v] of Object.entries(vals || {})) {
    const ctl = controls && controls[k];
    // seed controls are never pruned: their value is realized at generate
    // time (-1 = random), so "equals the default" doesn't mean "untouched"
    if (ctl && ctl.type !== 'seed' && ctl.default !== undefined && v === ctl.default) continue;
    out[k] = v;
  }
  return out;
}

// ---------- fidelity: dry run + diff ----------
// The permanent divergence detector: what would the app POST for this
// workflow, and how does that differ from a pure conversion of the raw
// .json with no app patching? Every diff entry is annotated with the
// manifest control that caused it — an entry WITHOUT a control key is an
// unexplained divergence, i.e. a bug.
function diffApiGraphs(before, after) {
  const diffs = [];
  for (const id of new Set([...Object.keys(before || {}), ...Object.keys(after || {})])) {
    const a = before[id], b = after[id];
    if (!a || !b) {
      diffs.push({ node: id, input: null, from: a ? 'node present' : 'node missing', to: b ? 'node present' : 'node missing' });
      continue;
    }
    for (const k of new Set([...Object.keys(a.inputs || {}), ...Object.keys(b.inputs || {})])) {
      const va = (a.inputs || {})[k], vb = (b.inputs || {})[k];
      if (JSON.stringify(va) !== JSON.stringify(vb)) {
        diffs.push({ node: id, class_type: (b.class_type || a.class_type), input: k, from: va, to: vb });
      }
    }
  }
  return diffs;
}

// Wired inputs whose source can't be resolved (muted/bypassed with nothing to
// forward, broken Set/Get pair, unconnected subgraph boundary). The converter
// omits these — the server then runs the node's DEFAULT for an optional
// input, which is a silent fidelity change. Surfaced here so the dry run can
// report them.
function listDroppedWires(graph) {
  const { nodes, resolve } = flattenUiGraph(graph);
  const dropped = [];
  for (const n of nodes) {
    for (const inp of n.inputs || []) {
      if (inp.link != null && !resolve(inp.link)) {
        dropped.push({ node: n.id, class_type: n.type, input: inp.name, type: inp.type });
      }
    }
  }
  return dropped;
}

// values must already be pruned/realized exactly as the generate path does —
// the caller (comfy.js) shares that code so the dry run can never drift from
// the real POST. info: merged /object_info (required for UI-format graphs).
function dryRunGraph(graph, manifest, values, info) {
  const ui = isUiGraph(graph);
  const pure = ui ? uiGraphToApi(graph, info) : JSON.parse(JSON.stringify(graph));
  const patched = patchWorkflow(pure, manifest, values || {});
  // target -> control key (dotted Power-Lora inputs land on the parent object)
  const byTarget = new Map();
  for (const [key, ctl] of Object.entries((manifest && manifest.controls) || {})) {
    for (const t of ctl.targets || [{ node: ctl.node, input: ctl.input }]) {
      byTarget.set(t.node + ':' + t.input, key);
      const dot = String(t.input).indexOf('.');
      if (dot > 0) byTarget.set(t.node + ':' + t.input.slice(0, dot), key);
    }
  }
  const diff = diffApiGraphs(pure, patched).map(d => {
    const key = byTarget.get(d.node + ':' + d.input);
    return key ? { ...d, control: key } : d;
  });
  return { pure, patched, diff, droppedWires: ui ? listDroppedWires(graph) : [] };
}

// ---------- output naming ----------
// <prefix>-YYYYMMDD-HHMMSS-<seed>.<ext>, suffixed -2, -3… on collision — the
// same convention as sd-core.imageFileName. vid-* for video workflows,
// img-* for ComfyUI image workflows (sd-* stays Forge's).
function mediaFileName(dir, seed, ext, prefix, now = new Date()) {
  const p2 = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}-${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}`;
  const baseName = `${prefix}-${stamp}-${seed != null ? seed : 'x'}`;
  let name = `${baseName}.${ext}`, i = 1;
  while (fs.existsSync(path.join(dir, name))) name = `${baseName}-${++i}.${ext}`;
  return name;
}
function videoFileName(dir, seed, ext = 'mp4', now = new Date()) {
  return mediaFileName(dir, seed, ext, 'vid', now);
}

// ---------- UI-graph -> API-format conversion ----------
// ComfyUI's default Ctrl+S export is the UI/graph format (nodes[] + links[]),
// not the API format /prompt expects. Rather than force users to re-export
// with "Save (API format)", convert at generate time. Widget values in the
// graph are a POSITIONAL array; /object_info supplies the input-name order,
// so conversion needs a running server (which generation implies anyway).
const UI_NOTE_TYPES = new Set(['Note', 'MarkdownNote', 'PrimitiveNote']);
// KJNodes SetNode/GetNode route a value by variable name instead of a wire;
// Reroute is a visual elbow. All editor-only — resolution sees through them.
const UI_ROUTE_TYPES = new Set(['SetNode', 'GetNode', 'Reroute', 'Reroute (rgthree)']);
// pure editor control panels: no data flows through them at all
const UI_PANEL_TYPES = new Set([
  'Fast Groups Bypasser (rgthree)', 'Fast Groups Muter (rgthree)',
  'Fast Bypasser (rgthree)', 'Fast Muter (rgthree)',
  'Label (rgthree)', 'Bookmark (rgthree)'
]);

function isUiGraph(graph) {
  return !!graph && Array.isArray(graph.nodes);
}

// Expand subgraph instances (definitions.subgraphs, node type = the def's
// uuid) into a flat node list. Inner nodes get "instId:innerId" ids — the
// same convention ComfyUI's frontend uses when it flattens for /prompt — so
// manifest node references survive re-exports. Returns:
//   nodes    — executable nodes only (no notes/muted/bypassed, no instances,
//              no SetNode/GetNode), inputs[].link rewritten to scoped keys
//   resolve  — (scoped link key) -> [flatNodeId, outputSlot] | null, following
//              subgraph boundaries (inputNode id -10 / outputNode id -20),
//              GetNode -> same-scope SetNode, and bypassed pass-through
function flattenUiGraph(graph) {
  const defs = new Map();
  for (const sg of (graph.definitions && graph.definitions.subgraphs) || []) defs.set(sg.id, sg);
  const scopedId = (scope, id) => scope ? scope + ':' + id : String(id);
  const linkKey = (scope, id) => (scope ? scope + ':' : '') + 'L' + id;

  const nodes = [];           // executable, flattened
  const rawById = new Map();  // scoped id -> { node, scope } for every node, virtual included
  const linkMeta = new Map(); // scoped link key -> { origin, slot, type, scope }
  const scopeInfo = new Map();// instance scoped id -> { def, parentScope, instanceNode }

  function addScope(scope, scopeNodes, scopeLinks) {
    for (const l of scopeLinks || []) {
      if (Array.isArray(l)) linkMeta.set(linkKey(scope, l[0]), { origin: l[1], slot: l[2], type: l[5], scope });
      else if (l && l.id != null) linkMeta.set(linkKey(scope, l.id), { origin: l.origin_id, slot: l.origin_slot, type: l.type, scope });
    }
    for (const n of scopeNodes || []) {
      if (!n) continue;
      const sid = scopedId(scope, n.id);
      rawById.set(sid, { node: n, scope });
      if (defs.has(n.type)) {
        // muted (2) or bypassed (4) instance: whole subtree never executes
        if (n.mode === 2 || n.mode === 4) continue;
        const def = defs.get(n.type);
        scopeInfo.set(sid, { def, parentScope: scope, instanceNode: n });
        addScope(sid, def.nodes, def.links);
        continue;
      }
      if (UI_NOTE_TYPES.has(n.type) || UI_ROUTE_TYPES.has(n.type) || UI_PANEL_TYPES.has(n.type)) continue;
      if (n.mode === 2 || n.mode === 4) continue;
      nodes.push({
        ...n, id: sid,
        inputs: (n.inputs || []).map(i => ({ ...i, link: i.link != null ? linkKey(scope, i.link) : null }))
      });
    }
  }
  addScope('', graph.nodes, graph.links);
  const flatIds = new Set(nodes.map(n => n.id));

  function resolve(key) {
    for (let hops = 0; key != null && hops < 128; hops++) {
      const meta = linkMeta.get(key);
      if (!meta) return null;
      // subgraph boundary input: hop to the outer link feeding the instance's
      // matching input slot (by name first — real exports keep them aligned)
      if (meta.origin === -10) {
        const info = scopeInfo.get(meta.scope);
        if (!info) return null;
        const bIn = (info.def.inputs || [])[meta.slot];
        const instInputs = info.instanceNode.inputs || [];
        const inst = (bIn && instInputs.find(i => i.name === bIn.name)) || instInputs[meta.slot];
        if (!inst || inst.link == null) return null;    // boundary left unconnected
        key = linkKey(info.parentScope, inst.link);
        continue;
      }
      const srcId = scopedId(meta.scope, meta.origin);
      const entry = rawById.get(srcId);
      if (!entry) return null;
      const n = entry.node;
      if (defs.has(n.type)) {
        if (n.mode === 2) return null;
        if (n.mode === 4) {                             // bypassed instance forwards same-typed input
          const through = (n.inputs || []).find(i => i.type === meta.type && i.link != null);
          if (!through) return null;
          key = linkKey(entry.scope, through.link);
          continue;
        }
        // active instance output: hop to the def's inner link feeding that pin
        const bOut = (defs.get(n.type).outputs || [])[meta.slot];
        const innerLink = bOut && bOut.linkIds && bOut.linkIds[0];
        if (innerLink == null) return null;
        key = linkKey(srcId, innerLink);
        continue;
      }
      if (UI_ROUTE_TYPES.has(n.type)) {
        // GetNode: jump to the same-named SetNode in the same scope, then
        // continue from its input. SetNode passthrough and Reroute: their own
        // single wired input.
        let setter = n;
        if (n.type === 'GetNode') {
          const varName = (n.widgets_values || [])[0];
          const siblings = entry.scope === '' ? (graph.nodes || []) : (scopeInfo.get(entry.scope).def.nodes || []);
          setter = siblings.find(m => m && m.type === 'SetNode' && (m.widgets_values || [])[0] === varName);
        }
        const setIn = setter && (setter.inputs || []).find(i => i.link != null);
        if (!setIn) return null;
        key = linkKey(entry.scope, setIn.link);
        continue;
      }
      if (n.mode === 2 || UI_NOTE_TYPES.has(n.type)) return null;
      if (n.mode === 4) {                               // bypassed node forwards same-typed input
        const through = (n.inputs || []).find(i => i.type === meta.type && i.link != null);
        if (!through) return null;
        key = linkKey(entry.scope, through.link);
        continue;
      }
      return flatIds.has(srcId) ? [srcId, meta.slot] : null;
    }
    return null;
  }

  return { nodes, resolve };
}

function uiGraphTypes(graph) {
  return [...new Set(flattenUiGraph(graph).nodes.map(n => n.type))];
}

// info: merged /object_info responses covering every active node type.
// Returns the id-keyed API graph ({ inputs, class_type, _meta } per node).
function uiGraphToApi(graph, info) {
  const { nodes, resolve } = flattenUiGraph(graph);
  const out = {};
  for (const n of nodes) {
    const def = info && info[n.type];
    if (!def) throw new Error(`workflow uses node type "${n.type}" (id ${n.id}) that this ComfyUI does not provide`);
    const specs = { ...((def.input && def.input.required) || {}), ...((def.input && def.input.optional) || {}) };
    const wv = n.widgets_values;
    const inputs = {};

    // connections: every wired input entry. An unresolvable wire (source
    // bypassed/muted with nothing to forward) is omitted, matching the
    // frontend's export of a dead branch — the server's own /prompt
    // validation rejects it if it was required.
    for (const inp of n.inputs || []) {
      if (inp.link == null) continue;
      const src = resolve(inp.link);
      if (src) inputs[inp.name] = src;
    }

    // widgets, three export styles:
    const seedish = (name, spec) =>
      ((Array.isArray(spec) && spec[1]) || {}).control_after_generate === true ||
      name === 'seed' || name === 'noise_seed';
    const widgetIns = (n.inputs || []).filter(i => i.widget);
    if (wv && typeof wv === 'object' && !Array.isArray(wv)) {
      // 1) named object (VHS_VideoCombine): copy every primitive widget value.
      // The static spec does NOT list dynamic per-format widgets (crf,
      // save_metadata, trim_to_audio only exist once format=h264-mp4), yet
      // the browser sends them and VHS consumes them — dropping them would
      // silently re-encode with defaults. UI-only extras are object-valued
      // (videopreview) and connection-typed spec entries are wires, so both
      // stay out.
      for (const [name, v] of Object.entries(wv)) {
        if (inputs[name] !== undefined || v === null || v === undefined || typeof v === 'object') continue;
        if (specs[name] && !isWidgetSpec(specs[name])) continue;
        inputs[name] = v;
      }
    } else if (widgetIns.length) {
      // 2) widget-marked input entries carry the widget ORDER (dynamic-widget
      // nodes may have inputs the static spec doesn't even list) — trust them
      let w = 0;
      for (const inp of widgetIns) {
        const v = (wv || [])[w++];
        if (seedish(inp.name, specs[inp.name]) && CONTROL_AFTER.includes((wv || [])[w])) w++;
        if (inputs[inp.name] === undefined && v !== undefined) inputs[inp.name] = v;
      }
    } else {
      // 3) classic positional array walked in /object_info spec order
      let w = 0;
      for (const [name, spec] of Object.entries(specs)) {
        if (!isWidgetSpec(spec)) continue;
        const v = (wv || [])[w++];
        // seed-style widgets carry a hidden "control_after_generate" slot
        if (((Array.isArray(spec) && spec[1]) || {}).control_after_generate === true ||
            ((name === 'seed' || name === 'noise_seed') && CONTROL_AFTER.includes((wv || [])[w]))) w++;
        if (inputs[name] === undefined && v !== undefined) inputs[name] = v;
      }
    }
    // rgthree's Power Lora Loader stores loras as named OBJECT widgets, not
    // positional values — each { lora } object becomes a lora_N input, the
    // shape its API-format export uses
    if (n.type === 'Power Lora Loader (rgthree)' && Array.isArray(wv)) {
      let li = 0;
      for (const v of wv) if (v && typeof v === 'object' && v.lora) inputs['lora_' + (++li)] = v;
    }
    out[n.id] = {
      inputs,
      class_type: n.type,
      _meta: { title: n.title || (n.properties && n.properties['Node name for S&R']) || n.type }
    };
  }
  return out;
}

// ---------- history output picking ----------
// /history outputs are { nodeId: { images|gifs|…: [{filename,…}] } }. Pick
// THE result file: manifest "output" pins the node whose files count (a
// multi-stage pipeline saves intermediates too — those must never win), then
// prefer the extension matching the workflow's media. Returns
// { pick, fallback } — fallback=true means the pinned node produced nothing.
//
// Without a pin, ranking is deterministic instead of relying on JS integer-key
// iteration order (which is ascending-numeric and would let a low-id
// intermediate save beat the real output): prefer the last-EXECUTED node
// (comfy.js derives it from history), then final ('output'-type) files over
// 'temp'/'input' previews.
function pickHistoryOutput(outputs, media, outputNode, lastNode) {
  const all = outputs || {};
  const want = outputNode != null ? String(outputNode) : null;
  const fallback = !!(want && !all[want]);
  let src;
  if (want && all[want]) src = { [want]: all[want] };
  else if (!want && lastNode != null && all[String(lastNode)]) src = { [String(lastNode)]: all[String(lastNode)] };
  else src = all;
  const produced = [];
  for (const nodeOut of Object.values(src)) {
    for (const arr of Object.values(nodeOut || {})) {
      if (!Array.isArray(arr)) continue;
      for (const item of arr) if (item && item.filename) produced.push(item);
    }
  }
  // final results are type 'output'; previews/intermediates are 'temp'/'input'
  const finals = produced.filter(f => f.type === 'output' || f.type === undefined);
  const pool = finals.length ? finals : produced;
  const isVideo = (f) => /\.(mp4|webm|mov|avi|gif|webp)$/i.test(f.filename);
  const isImage = (f) => /\.(png|jpe?g|webp|bmp)$/i.test(f.filename);
  const pick = (media === 'image' ? pool.find(isImage) : pool.find(isVideo)) || pool[0] || null;
  return { pick, fallback };
}

// ---------- /object_info fetching ----------
// Node type names are legal with spaces and parens ("Power Lora Loader
// (rgthree)", "Seed (rgthree)") — encodeURIComponent keeps them one path
// segment. Only genuinely path-breaking names (separators, control chars)
// are rejected.
function objectInfoRoute(type) {
  const t = String(type || '');
  if (!t || /[/\\\u0000-\u001f]/.test(t)) throw new Error(`bad node type "${t}" — not a legal /object_info name`);
  return '/object_info/' + encodeURIComponent(t);
}

// Fetch (and cache, per type) the /object_info specs for a set of node
// types, merged into one object for uiGraphToApi. get(route) -> Response —
// the caller supplies its HTTP (comfy.js passes cfetch; tests a local server).
async function fetchTypeInfo(types, get, cache) {
  const info = {};
  for (const t of types) {
    if (!cache.has(t)) {
      const r = await get(objectInfoRoute(t));
      if (!r.ok) throw new Error(`object_info ${t}: HTTP ${r.status}`);
      cache.set(t, await r.json());
    }
    Object.assign(info, cache.get(t));
  }
  return info;
}

// ---------- /object_info dropdowns ----------
// A manifest select can declare "options_from": "object_info:<NodeType>:<input>"
// to populate live from ComfyUI (samplers, schedulers, model files) instead of
// hardcoding lists. This extracts the options array from a /object_info/<Type>
// response: combo inputs are [[...options], {meta}] under input.required/optional.
function objectInfoOptions(info, nodeType, input) {
  const node = info && info[nodeType];
  const inputs = (node && node.input) || {};
  const def = (inputs.required && inputs.required[input]) || (inputs.optional && inputs.optional[input]);
  return Array.isArray(def) && Array.isArray(def[0]) ? def[0].map(String) : [];
}

// ---------- manifest auto-generation ----------
// buildManifest parses a UI-format workflow export (subgraphs included, via
// flattenUiGraph — so node references use the same flattened ids the
// converter produces) and extracts the runtime-editable controls, emitting
// the exact manifest shape the hand-written ones used. generated.sourceHash
// marks it auto-generated; a manifest without that field is hand-authored
// and never overwritten.
const NEGATIVE_WORDS = /blurry|distorted|low resolution|low quality|worst quality|watermark|jpeg artifacts|compression artifacts|deformed|disfigured|ugly|bad anatomy|oversaturated|grainy|pixelated|noise/gi;
const LATENT_TYPES = new Set(['EmptyLatentImage', 'EmptySD3LatentImage', 'EmptyLTXVLatentVideo']);
const CONST_TYPES = new Set(['INTConstant', 'PrimitiveInt', 'PrimitiveFloat']);
const OUTPUT_VIDEO_TYPES = new Set(['VHS_VideoCombine', 'SaveVideo', 'SaveWEBM', 'SaveAnimatedWEBP', 'CreateVideo']);
const LORA_OPTIONS = 'object_info:LoraLoaderModelOnly:lora_name';
// model-file widgets per loader type: each static one becomes a select fed
// live from that type's /object_info combo (so GGUF quants, checkpoints,
// text encoders, VAEs and upscalers are all swappable from the app)
const MODEL_LOADERS = {
  UnetLoaderGGUF: [['unet_name', 'model']],
  UNETLoader: [['unet_name', 'model']],
  CheckpointLoaderSimple: [['ckpt_name', 'model']],
  CLIPLoader: [['clip_name', 'text_encoder']],
  CLIPLoaderGGUF: [['clip_name', 'text_encoder']],
  DualCLIPLoader: [['clip_name1', 'text_encoder'], ['clip_name2', 'text_encoder']],
  DualCLIPLoaderGGUF: [['clip_name1', 'text_encoder'], ['clip_name2', 'text_encoder']],
  VAELoader: [['vae_name', 'vae']],
  VAELoaderKJ: [['vae_name', 'vae']],
  LatentUpscaleModelLoader: [['model_name', 'upscale_model']],
  UpscaleModelLoader: [['model_name', 'upscale_model']]
};
// nodes that ARE a sampling pass — used to order multi-pass pipelines
// (main vs refine) when labeling per-pass sampling controls
const SAMPLER_PASS_TYPES = new Set(['SamplerCustomAdvanced', 'SamplerCustom', 'KSampler', 'KSamplerAdvanced']);
const CONTROL_AFTER = ['fixed', 'increment', 'decrement', 'randomize'];
// combos are arrays; primitive types are widgets; anything else
// (MODEL, LATENT, CONDITIONING, …) is a connection
const isWidgetSpec = (spec) => {
  const typeSpec = Array.isArray(spec) ? spec[0] : spec;
  return Array.isArray(typeSpec) ||
    typeSpec === 'INT' || typeSpec === 'FLOAT' || typeSpec === 'STRING' ||
    typeSpec === 'BOOLEAN' || typeSpec === 'COMBO';
};

const stripEmoji = (s) => String(s || '').replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, ' ').trim();
const titleSlug = (s) => stripEmoji(s).replace(/\([^)]*\)/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
// a widget promoted to a wired input carries a link — its stored value is
// stale and must never become a control default
const widgetLinked = (n, name) => (n.inputs || []).some(i => i.name === name && i.link != null);
const wval = (n, i) => Array.isArray(n.widgets_values) ? n.widgets_values[i] : undefined;
const nodeDepth = (n) => (n.id.match(/:/g) || []).length;
// read a NAMED widget's stored value: named-object exports directly; the
// positional array is walked in widget-input order, skipping the hidden
// control_after_generate slot that trails seed-style widgets — the same walk
// uiGraphToApi does. Nodes without widget-marked inputs return undefined.
const widgetVal = (n, name) => {
  const wv = n.widgets_values;
  if (wv && typeof wv === 'object' && !Array.isArray(wv)) return wv[name];
  let w = 0;
  for (const inp of (n.inputs || []).filter(i => i.widget)) {
    const v = (wv || [])[w++];
    if (inp.name === name) return v;
    if ((inp.name === 'seed' || inp.name === 'noise_seed') && CONTROL_AFTER.includes((wv || [])[w])) w++;
  }
  return undefined;
};

// classic positional export (no inputs[].widget markers): walk widgets_values
// in the /object_info spec's widget order — the same walk uiGraphToApi does
const widgetValSpec = (n, name, spec) => {
  const wv = n.widgets_values;
  if (!Array.isArray(wv)) return undefined;
  let w = 0;
  for (const [k, s] of Object.entries(spec)) {
    if (!isWidgetSpec(s)) continue;
    const v = wv[w++];
    if (((Array.isArray(s) && s[1]) || {}).control_after_generate === true ||
        ((k === 'seed' || k === 'noise_seed') && CONTROL_AFTER.includes(wv[w]))) w++;
    if (k === name) return v;
  }
  return undefined;
};

function extractControls({ nodes, resolve }, info) {
  const controls = {};
  const freeKey = (base) => { let k = base, i = 1; while (controls[k]) k = `${base}_${++i}`; return k; };
  const put = (k, ctl, n) => {
    const l = stripEmoji(n.title || '');
    controls[k] = ctl.label || !l ? ctl : { ...ctl, label: l };
  };
  const staticNum = (n, name) => !widgetLinked(n, name) && typeof widgetVal(n, name) === 'number';
  const staticStr = (n, name) => !widgetLinked(n, name) && typeof widgetVal(n, name) === 'string';

  // ---- sampling passes: a sampler fed (transitively) from another sampler's
  // output runs later — that dependency order names the passes. Guiders,
  // sigma schedules, sampler selects and i2v conditioners are then labeled by
  // the pass that CONSUMES them, so main and refine knobs stay tellable apart.
  const byId = new Map(nodes.map(n => [n.id, n]));
  const srcsOf = (n) => {
    const out = [];
    for (const i of n.inputs || []) {
      if (i.link == null) continue;
      const s = resolve(i.link);
      if (s) out.push(s[0]);
    }
    return out;
  };
  const upstreamOf = (id) => {
    const seen = new Set(), stack = [id];
    while (stack.length) {
      const n = byId.get(stack.pop());
      if (!n) continue;
      for (const s of srcsOf(n)) if (!seen.has(s)) { seen.add(s); stack.push(s); }
    }
    return seen;
  };
  const passes = nodes.filter(n => SAMPLER_PASS_TYPES.has(n.type));
  const upstreams = new Map(passes.map(n => [n.id, upstreamOf(n.id)]));
  passes.sort((a, b) =>
    [...upstreams.get(a.id)].filter(id => upstreams.has(id)).length -
    [...upstreams.get(b.id)].filter(id => upstreams.has(id)).length);
  const consumers = new Map();
  for (const n of nodes) for (const s of srcsOf(n)) {
    if (!consumers.has(s)) consumers.set(s, []);
    consumers.get(s).push(n.id);
  }
  const passOf = (id) => {              // index of the consuming pass, -1 if none
    const seen = new Set([id]), q = [id];
    while (q.length) {
      const cur = q.shift();
      const pi = passes.findIndex(p => p.id === cur);
      if (pi >= 0) return pi;
      for (const c of consumers.get(cur) || []) if (!seen.has(c)) { seen.add(c); q.push(c); }
    }
    return -1;
  };
  const passName = (pi) => pi < 0 || passes.length < 2 ? null
    : pi === 0 ? 'main pass' : passes.length === 2 ? 'refine pass' : `pass ${pi + 1}`;

  // identical values across all instances -> ONE control moving them together
  // (multi-target, exactly like seed); differing values -> one control each,
  // labeled by consuming pass (or by the node's own title when unconsumed)
  const emitPer = (base, labelBase, items, ctlBase) => {
    if (!items.length) return;
    if (items.length > 1 && items.every(it => it.value === items[0].value)) {
      controls[freeKey(base)] = {
        targets: items.map(it => ({ node: it.n.id, input: it.input })),
        ...ctlBase, ...(items[0].extra || {}), default: items[0].value
      };
      return;
    }
    const ordered = items.map(it => ({ ...it, pass: passOf(it.n.id) }))
      .sort((a, b) => (a.pass < 0 ? 99 : a.pass) - (b.pass < 0 ? 99 : b.pass));
    for (const it of ordered) {
      const label = passName(it.pass) ? `${labelBase} (${passName(it.pass)})` : stripEmoji(it.n.title || '');
      controls[freeKey(base)] = {
        node: it.n.id, input: it.input, ...ctlBase, ...(it.extra || {}),
        default: it.value, ...(label ? { label } : {})
      };
    }
  };

  // ---- prompts: static text only; negative by title or quality-word density;
  // positive prefers explicit titles, then the shallowest (top-level) node
  const isNegative = (n, text) => /negative/i.test(n.title || '') ||
    (String(text).match(NEGATIVE_WORDS) || []).length >= 2;
  const cands = [];
  for (const n of nodes) {
    if (n.type === 'CLIPTextEncode' && !widgetLinked(n, 'text') && typeof wval(n, 0) === 'string')
      cands.push({ n, input: 'text', text: wval(n, 0) });
    else if (n.type === 'PrimitiveStringMultiline' && !widgetLinked(n, 'value') &&
        /prompt/i.test(n.title || '') && !/trigger|system/i.test(n.title || ''))
      cands.push({ n, input: 'value', text: wval(n, 0) });
  }
  const rank = (c) => (/positive|user prompt/i.test(c.n.title || '') ? -10 : 0) + nodeDepth(c.n) * 5;
  const poss = cands.filter(c => !isNegative(c.n, c.text)).sort((a, b) => rank(a) - rank(b));
  const negs = cands.filter(c => isNegative(c.n, c.text)).sort((a, b) => nodeDepth(a.n) - nodeDepth(b.n));
  if (poss[0]) put('prompt', { node: poss[0].n.id, input: poss[0].input, type: 'textarea', group: 'Basic' }, poss[0].n);
  if (negs[0]) put('negative', { node: negs[0].n.id, input: negs[0].input, type: 'textarea', group: 'Basic' }, negs[0].n);

  // ---- seed: every static seed widget. Identical stored values move
  // together as ONE control (reproducible with a single number); DIFFERING
  // values mean the workflow deliberately decorrelates its noise streams
  // (e.g. separate video and audio passes) — merging them would patch one
  // seed into both and make browser-parity impossible, so they split into
  // per-pass controls exactly like cfg/sigmas (each realized independently
  // at generate time).
  const SEED_FIELDS = { RandomNoise: 'noise_seed', KSampler: 'seed', 'Seed (rgthree)': 'seed' };
  const seedItems = [];
  for (const n of nodes) {
    const f = SEED_FIELDS[n.type];
    if (f && !widgetLinked(n, f) && typeof wval(n, 0) === 'number')
      seedItems.push({ n, input: f, value: wval(n, 0) });
  }
  if (seedItems.length === 1) {
    controls.seed = { node: seedItems[0].n.id, input: seedItems[0].input, type: 'seed', group: 'Basic' };
  } else if (seedItems.length && seedItems.every(it => it.value === seedItems[0].value)) {
    controls.seed = { targets: seedItems.map(it => ({ node: it.n.id, input: it.input })), type: 'seed', group: 'Basic' };
  } else if (seedItems.length) {
    emitPer('seed', 'Seed', seedItems, { type: 'seed', group: 'Basic' });
  }

  // ---- resolution: titled INT constants are the user-facing knobs and win
  // over latent nodes (whose size inputs are usually link-driven plumbing)
  const titledConst = (want) => nodes.find(n => CONST_TYPES.has(n.type) &&
    titleSlug(n.title || '') === want && !widgetLinked(n, 'value') && typeof wval(n, 0) === 'number');
  const latent = nodes.find(n => LATENT_TYPES.has(n.type) &&
    !widgetLinked(n, 'width') && !widgetLinked(n, 'height') && typeof wval(n, 0) === 'number');
  const sizeCtl = (which, idx) => {
    const t = titledConst(which);
    if (t) return put(which, { node: t.id, input: 'value', type: 'int', default: wval(t, 0), min: 64, max: 4096, step: 8, group: 'Basic' }, t);
    if (latent) put(which, { node: latent.id, input: which, type: 'int', default: wval(latent, idx), min: 64, max: 4096, step: 8, group: 'Basic' }, latent);
  };
  sizeCtl('width', 0);
  sizeCtl('height', 1);

  // ---- video pacing: LENGTH (seconds) / FPS titled constants, else a
  // VHS_VideoCombine with a static frame_rate (named object widgets)
  const len = titledConst('length');
  if (len) put('length', { node: len.id, input: 'value', type: 'int', default: wval(len, 0), min: 1, max: 60, group: 'Video' }, len);
  const fps = titledConst('fps');
  if (fps) put('fps', { node: fps.id, input: 'value', type: 'float', default: wval(fps, 0), min: 1, max: 60, group: 'Video' }, fps);
  else {
    const vhs = nodes.find(n => n.type === 'VHS_VideoCombine' && !widgetLinked(n, 'frame_rate') &&
      n.widgets_values && !Array.isArray(n.widgets_values) && typeof n.widgets_values.frame_rate === 'number');
    if (vhs) put('fps', { node: vhs.id, input: 'frame_rate', type: 'float', default: vhs.widgets_values.frame_rate, min: 1, max: 60, group: 'Video' }, vhs);
  }

  // ---- images: a select over files already in ComfyUI's input folder
  for (const n of nodes) {
    if (n.type !== 'LoadImage' || widgetLinked(n, 'image') || typeof wval(n, 0) !== 'string') continue;
    put(freeKey('image'), { node: n.id, input: 'image', type: 'select', options_from: 'object_info:LoadImage:image', default: wval(n, 0), group: 'Basic' }, n);
  }

  // ---- toggles: every static PrimitiveBoolean, keyed by slugified title
  for (const n of nodes) {
    if (n.type !== 'PrimitiveBoolean' || widgetLinked(n, 'value') || typeof wval(n, 0) !== 'boolean') continue;
    put(freeKey(titleSlug(n.title || '') || 'toggle'), { node: n.id, input: 'value', type: 'checkbox', default: wval(n, 0), group: 'Options' }, n);
  }

  // ---- loras: Power Lora rows via the dotted path, plain loaders directly.
  // Each file select brings its strength (0 = effective bypass) and, for
  // Power rows, the slot's on/off so a lora can be benched without removal.
  for (const n of nodes) {
    const loraTitle = stripEmoji(n.title || '') || 'LoRA';
    if (n.type === 'Power Lora Loader (rgthree)') {
      let li = 0;
      for (const v of Array.isArray(n.widgets_values) ? n.widgets_values : []) {
        if (!v || typeof v !== 'object' || !v.lora) continue;
        li++;
        const k = freeKey('lora');
        put(k, { node: n.id, input: `lora_${li}.lora`, type: 'select', options_from: LORA_OPTIONS, default: v.lora, group: 'LoRA' }, n);
        if (typeof v.strength === 'number')
          controls[`${k}_strength`] = { node: n.id, input: `lora_${li}.strength`, type: 'float',
            default: v.strength, min: 0, max: 2, step: 0.05, group: 'LoRA', label: `${loraTitle} strength` };
        if (typeof v.on === 'boolean')
          controls[`${k}_on`] = { node: n.id, input: `lora_${li}.on`, type: 'checkbox',
            default: v.on, group: 'LoRA', label: `${loraTitle} on` };
      }
    } else if ((n.type === 'LoraLoaderModelOnly' || n.type === 'LoraLoader') &&
        !widgetLinked(n, 'lora_name') && typeof wval(n, 0) === 'string') {
      const k = freeKey('lora');
      put(k, { node: n.id, input: 'lora_name', type: 'select', options_from: LORA_OPTIONS, default: wval(n, 0), group: 'LoRA' }, n);
      if (staticNum(n, 'strength_model'))
        controls[`${k}_strength`] = { node: n.id, input: 'strength_model', type: 'float',
          default: widgetVal(n, 'strength_model'), min: 0, max: 2, step: 0.05, group: 'LoRA',
          label: `${loraTitle} strength` };
    }
  }

  // ---- models: every static file widget on a loader becomes a swap select;
  // a loader with several file widgets (DualCLIP) numbers the later labels
  for (const n of nodes) {
    (MODEL_LOADERS[n.type] || []).forEach(([input, base], idx) => {
      if (!staticStr(n, input)) return;
      const title = stripEmoji(n.title || '');
      put(freeKey(base), {
        node: n.id, input, type: 'select',
        options_from: `object_info:${n.type}:${input}`,
        default: widgetVal(n, input), group: 'Models',
        ...(idx > 0 && title ? { label: `${title} ${idx + 1}` } : {})
      }, n);
    });
  }

  // ---- sampling quality: cfg (guiders and samplers), sampler choice, manual
  // sigma schedules (how these workflows express steps), i2v conditioning
  // strength. Identical pairs collapse to multi-target; different values
  // split into per-pass controls (see emitPer).
  const cfgItems = [], samplerItems = [], sigmaItems = [], i2vItems = [];
  for (const n of nodes) {
    if ((n.type === 'CFGGuider' || n.type === 'KSampler') && staticNum(n, 'cfg'))
      cfgItems.push({ n, input: 'cfg', value: widgetVal(n, 'cfg') });
    if ((n.type === 'KSamplerSelect' || n.type === 'KSampler') && staticStr(n, 'sampler_name'))
      samplerItems.push({ n, input: 'sampler_name', value: widgetVal(n, 'sampler_name'),
        extra: { options_from: `object_info:${n.type}:sampler_name` } });
    if (n.type === 'ManualSigmas' && staticStr(n, 'sigmas'))
      sigmaItems.push({ n, input: 'sigmas', value: widgetVal(n, 'sigmas') });
    if (n.type === 'LTXVImgToVideoInplace' && staticNum(n, 'strength'))
      i2vItems.push({ n, input: 'strength', value: widgetVal(n, 'strength') });
  }
  const ADV = 'Sampling (advanced)';
  emitPer('cfg', 'CFG', cfgItems, { type: 'float', min: 1, max: 10, step: 0.5, group: ADV });
  emitPer('sampler', 'Sampler', samplerItems, { type: 'select', group: ADV });
  emitPer('sigmas', 'Sigmas', sigmaItems, { type: 'text', group: ADV });
  emitPer('i2v_strength', 'Image strength', i2vItems, { type: 'float', min: 0, max: 1, step: 0.05, group: ADV });

  // ---- output container: VHS format + trim-to-audio when static (frame_rate
  // is usually wired and is already handled by the fps section)
  for (const n of nodes) {
    if (n.type !== 'VHS_VideoCombine') continue;
    const wv = n.widgets_values;
    if (!wv || typeof wv !== 'object' || Array.isArray(wv)) continue;
    if (!widgetLinked(n, 'format') && typeof wv.format === 'string')
      controls[freeKey('format')] = {
        node: n.id, input: 'format', type: 'select',
        options: [...new Set([wv.format, 'video/h264-mp4', 'image/gif'])],   // offline fallback
        options_from: 'object_info:VHS_VideoCombine:format',
        default: wv.format, group: 'Output'
      };
    if (!widgetLinked(n, 'trim_to_audio') && typeof wv.trim_to_audio === 'boolean')
      controls[freeKey('trim_to_audio')] = {
        node: n.id, input: 'trim_to_audio', type: 'checkbox',
        default: wv.trim_to_audio, group: 'Output', label: 'Trim to audio'
      };
  }

  // ---- generic sweep: EVERY remaining static widget is a potential control,
  // typed from the /object_info spec when available, inferred from the stored
  // value otherwise. All of them land hidden — the picker UI opts them in;
  // the heuristics above only decide what is VISIBLE by default. This is what
  // makes new node types zero-code: no type table, just the schema.
  const claimed = new Set();
  for (const ctl of Object.values(controls))
    for (const t of ctl.targets || [{ node: ctl.node, input: ctl.input }])
      claimed.add(t.node + ':' + t.input);

  for (const n of nodes) {
    const nodeInfo = info && info[n.type];
    const spec = nodeInfo && nodeInfo.input
      ? { ...(nodeInfo.input.required || {}), ...(nodeInfo.input.optional || {}) } : null;
    const wv = n.widgets_values;
    const namedWv = wv && typeof wv === 'object' && !Array.isArray(wv);
    const marked = (n.inputs || []).some(i => i.widget);
    // candidate widget names: named-object keys, widget-marked input names,
    // else (classic positional export) the spec's widget inputs in order
    let names;
    if (namedWv) names = Object.keys(wv);
    else if (marked) names = (n.inputs || []).filter(i => i.widget).map(i => i.name);
    else if (spec) names = Object.entries(spec).filter(([, s]) => isWidgetSpec(s)).map(([k]) => k);
    else names = [];

    for (const name of names) {
      if (claimed.has(n.id + ':' + name) || widgetLinked(n, name)) continue;
      const v = namedWv || marked ? widgetVal(n, name) : widgetValSpec(n, name, spec);
      if (v === undefined || v === null || typeof v === 'object') continue;   // objects = format quirks (rgthree slots, previews)
      const s = spec && spec[name];
      const typeSpec = Array.isArray(s) ? s[0] : s;
      const meta = (Array.isArray(s) && s[1]) || {};
      const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : undefined);
      let ctl;
      if (Array.isArray(typeSpec) || typeSpec === 'COMBO') {
        ctl = { type: 'select', options_from: `object_info:${n.type}:${name}` };
      } else if (typeSpec === 'INT' || typeSpec === 'FLOAT') {
        ctl = { type: typeSpec === 'INT' ? 'int' : 'float' };
        if (num(meta.min) !== undefined) ctl.min = meta.min;
        if (num(meta.max) !== undefined) ctl.max = meta.max;
        ctl.step = num(meta.step) !== undefined ? meta.step : (typeSpec === 'INT' ? 1 : 0.01);
      } else if (typeSpec === 'BOOLEAN') {
        ctl = { type: 'checkbox' };
      } else if (typeSpec === 'STRING') {
        ctl = { type: meta.multiline ? 'textarea' : 'text' };
      } else if (!s) {
        // no spec for this input (server offline, or a dynamic widget like
        // VHS's per-format extras) — type it from the stored value
        ctl = typeof v === 'boolean' ? { type: 'checkbox' }
          : typeof v === 'number' ? { type: 'float' }
          : { type: 'text' };
      } else continue;   // connection-typed spec with a stray value — not a widget
      if (typeof meta.tooltip === 'string') ctl.tooltip = meta.tooltip.slice(0, 300);
      const title = stripEmoji(n.title || '');
      const key = freeKey(`${titleSlug(n.title || n.type) || 'node'}_${name.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`);
      controls[key] = {
        node: n.id, input: name, ...ctl, default: v, hidden: true,
        label: name.charAt(0).toUpperCase() + name.slice(1).replace(/_/g, ' '),
        group: title || n.type
      };
      claimed.add(n.id + ':' + name);
    }
  }

  // ---- picker metadata: every control carries its node's type/title so the
  // Configure view can group by node without re-reading the graph
  for (const ctl of Object.values(controls)) {
    const t = ctl.targets ? ctl.targets[0] : ctl;
    const n = byId.get(t.node);
    if (!n) continue;
    ctl.node_type = n.type;
    ctl.node_title = stripEmoji(n.title || '');
  }

  // ---- the result node: video sinks beat image sinks; shallowest wins so a
  // detailer subgraph's intermediate save never outranks the real output
  const sinks = nodes.filter(n => OUTPUT_VIDEO_TYPES.has(n.type));
  const media = sinks.length ? 'video' : 'image';
  const pool = sinks.length ? sinks : nodes.filter(n => n.type === 'SaveImage');
  pool.sort((a, b) => nodeDepth(a) - nodeDepth(b));
  return { controls, media, output: pool[0] ? pool[0].id : undefined };
}

// info: merged /object_info specs (as fetchTypeInfo returns) — optional. With
// it, potential controls get real types/ranges/combos; without it (offline
// scan) extraction falls back to widget markers and stored-value typing, and
// generated.withInfo=false marks the manifest for a free upgrade on the first
// scan that reaches the server.
function buildManifest(jsonText, name, info = null) {
  const graph = JSON.parse(jsonText);
  if (!isUiGraph(graph)) throw new Error('not a UI-format workflow (no nodes[] array) — write a manifest by hand');
  const { controls, media, output } = extractControls(flattenUiGraph(graph), info);
  return {
    label: name, backend: 'comfy', media,
    ...(output ? { output } : {}),
    controls,
    generated: {
      sourceHash: 'sha256:' + crypto.createHash('sha256').update(jsonText).digest('hex'),
      withInfo: !!info
    }
  };
}

// Scan-path hook: every <name>.json in the workflows dir gets a generated
// <name>.manifest.json sidecar. sourceHash makes rescans cheap (unchanged
// file -> untouched manifest) and marks the file auto-generated — a manifest
// WITHOUT generated is hand-authored and is never overwritten, force or not.
// getInfo(types) -> merged /object_info specs or null (offline); a manifest
// built offline (withInfo=false) is regenerated once specs become reachable.
// A workflow that fails to parse gets { error } (hidden from listWorkflows,
// retried only when the file changes). Never throws; returns per-file actions:
// 'created' | 'updated' | 'fresh' | 'manual' | 'error'.
async function ensureManifests(dir, { force = false, getInfo = null } = {}) {
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch (_) { return []; }
  const results = [];
  for (const f of entries) {
    // presets/overrides/values live in the same folder but are user data, not workflows
    if (!f.endsWith('.json') || f.endsWith('.manifest.json') ||
        f === PRESETS_FILE || f === OVERRIDES_FILE || f === VALUES_FILE) continue;
    const name = f.slice(0, -'.json'.length);
    try {
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      const hash = 'sha256:' + crypto.createHash('sha256').update(text).digest('hex');
      const mFile = path.join(dir, name + '.manifest.json');
      let existing = null;
      if (fs.existsSync(mFile)) {
        try { existing = JSON.parse(fs.readFileSync(mFile, 'utf8')); }
        catch (_) { existing = null; }   // corrupt manifest -> regenerate
        if (existing && !(existing.generated && existing.generated.sourceHash)) {
          results.push({ name, action: 'manual' });
          continue;
        }
        // fresh by hash — but a manifest built without server specs still
        // upgrades below if getInfo can now deliver them
        if (existing && existing.generated.sourceHash === hash && !force &&
            (existing.generated.withInfo || !getInfo)) {
          results.push({ name, action: 'fresh' });
          continue;
        }
      }
      let info = null;
      if (getInfo) {
        try {
          const g = JSON.parse(text);
          if (isUiGraph(g)) info = await getInfo(uiGraphTypes(g));
        } catch (_) { info = null; }     // parse errors surface via buildManifest below
      }
      if (existing && existing.generated.sourceHash === hash && !force && !info) {
        results.push({ name, action: 'fresh' });   // still offline — keep the old one
        continue;
      }
      let manifest, action = existing ? 'updated' : 'created';
      try {
        manifest = buildManifest(text, name, info);
      } catch (err) {
        manifest = {
          label: name, backend: 'comfy',
          error: String(err && err.message || err).slice(0, 300),
          controls: {},
          generated: { sourceHash: hash, withInfo: !!info }
        };
        action = 'error';
      }
      fs.writeFileSync(mFile, JSON.stringify(manifest, null, 2) + '\n');
      results.push(action === 'error' ? { name, action, error: manifest.error } : { name, action });
    } catch (err) {   // unreadable file, disk error — report, keep scanning
      results.push({ name, action: 'error', error: String(err && err.message || err).slice(0, 300) });
    }
  }
  return results;
}

// ---------- prompt presets ----------
// Named per-workflow snapshots of the prompt controls, all in ONE file next
// to the workflow pairs: <workflowsDir>/prompt-presets.json, shaped
// { [workflowName]: [{ name, values }] }. Deliberately NOT inside the
// manifests — those are regenerated from the graph and must stay disposable.
// A missing or corrupt file reads as empty (error returned for the caller's
// log, never thrown); the next save recreates it.
const PRESETS_FILE = 'prompt-presets.json';

function readPromptPresets(dir) {
  const file = path.join(dir, PRESETS_FILE);
  if (!fs.existsSync(file)) return { presets: {} };
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('not an object');
    const presets = {};
    for (const [wf, list] of Object.entries(data)) {
      if (!Array.isArray(list)) continue;   // malformed entry -> dropped, not fatal
      presets[wf] = list.filter(p => p && typeof p.name === 'string' && p.values && typeof p.values === 'object');
    }
    return { presets };
  } catch (err) {
    return {
      presets: {},
      error: `prompt-presets.json unreadable (${String(err && err.message || err).slice(0, 120)}) — starting empty`
    };
  }
}

function writePromptPresets(dir, presets) {
  fs.writeFileSync(path.join(dir, PRESETS_FILE), JSON.stringify(presets, null, 2) + '\n');
}

// each mutator returns { list, error? } — list is the workflow's presets after
// the change; error is the read-side corruption note (surface it in the log)
function savePromptPreset(dir, workflow, name, values) {
  const nm = String(name || '').trim();
  if (!nm) throw new Error('preset needs a name');
  const { presets, error } = readPromptPresets(dir);
  const list = presets[workflow] = presets[workflow] || [];
  const existing = list.find(p => p.name === nm);
  if (existing) existing.values = values; else list.push({ name: nm, values });
  writePromptPresets(dir, presets);
  return { list, error };
}

function renamePromptPreset(dir, workflow, oldName, newName) {
  const nm = String(newName || '').trim();
  if (!nm) throw new Error('preset needs a name');
  const { presets, error } = readPromptPresets(dir);
  const list = presets[workflow] || [];
  const p = list.find(x => x.name === oldName);
  if (!p) throw new Error(`no preset "${oldName}" for ${workflow}`);
  if (nm !== oldName && list.some(x => x.name === nm)) throw new Error(`a preset named "${nm}" already exists`);
  p.name = nm;
  writePromptPresets(dir, presets);
  return { list, error };
}

function deletePromptPreset(dir, workflow, name) {
  const { presets, error } = readPromptPresets(dir);
  const list = (presets[workflow] || []).filter(p => p.name !== name);
  if (list.length) presets[workflow] = list; else delete presets[workflow];
  writePromptPresets(dir, presets);
  return { list, error };
}

// ---------- working control values ----------
// The implicit per-workflow DRAFT: the panel's current control values, saved
// so tab switches (which unmount the panel), workflow switches and app
// restarts never lose typed state. Distinct from prompt presets (named,
// deliberate snapshots) — loading a preset writes INTO this draft.
// <dir>/control-values.json, { [workflow]: { [controlKey]: value } }. Same
// sidecar contract as the others: corrupt -> empty + error note, never throws.
const VALUES_FILE = 'control-values.json';

function readControlValues(dir) {
  const file = path.join(dir, VALUES_FILE);
  if (!fs.existsSync(file)) return { values: {} };
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('not an object');
    const values = {};
    for (const [wf, vals] of Object.entries(data)) {
      if (!vals || typeof vals !== 'object' || Array.isArray(vals)) continue;
      const clean = {};
      for (const [k, v] of Object.entries(vals)) {
        if (v === null || v === undefined || typeof v === 'object') continue;   // primitives only
        clean[k] = v;
      }
      values[wf] = clean;
    }
    return { values };
  } catch (err) {
    return {
      values: {},
      error: `control-values.json unreadable (${String(err && err.message || err).slice(0, 120)}) — starting empty`
    };
  }
}

// replaces the workflow's draft wholesale — the caller sends the whole
// working set, so a control put back to its default simply drops out
function saveControlValues(dir, workflow, vals) {
  const { values, error } = readControlValues(dir);
  const clean = {};
  for (const [k, v] of Object.entries(vals || {})) {
    if (v === null || v === undefined || typeof v === 'object') continue;
    clean[k] = v;
  }
  values[workflow] = clean;
  fs.writeFileSync(path.join(dir, VALUES_FILE), JSON.stringify(values, null, 2) + '\n');
  return { values, error };
}

function clearControlValues(dir, workflow) {
  const { values, error } = readControlValues(dir);
  delete values[workflow];
  fs.writeFileSync(path.join(dir, VALUES_FILE), JSON.stringify(values, null, 2) + '\n');
  return { values, error };
}

// stale keys (a control removed by a rescan) are dropped silently
function pruneControlValues(vals, controls) {
  const out = {};
  for (const [k, v] of Object.entries(vals || {})) {
    if (controls && controls[k] !== undefined) out[k] = v;
  }
  return out;
}

// ---------- control overrides ----------
// The user's shown/hidden choices and custom labels from the "Configure
// controls" picker, in a sidecar next to the workflow pairs:
// <dir>/control-overrides.json, { [workflow]: { "<node>:<input>": { hidden, label } } }.
// Keyed by patch TARGET (not control key — key names can shift between
// rescans, node ids don't) and applied at READ time in listWorkflows, so
// manifest regeneration can never wipe them. Corrupt file -> empty + error
// note, same contract as prompt presets. Hand-authored manifests are exempt.
const OVERRIDES_FILE = 'control-overrides.json';

const controlTargetId = (ctl) => {
  const t = ctl.targets ? ctl.targets[0] : ctl;
  return t.node + ':' + t.input;
};

function readControlOverrides(dir) {
  const file = path.join(dir, OVERRIDES_FILE);
  if (!fs.existsSync(file)) return { overrides: {} };
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('not an object');
    const overrides = {};
    for (const [wf, map] of Object.entries(data)) {
      if (!map || typeof map !== 'object' || Array.isArray(map)) continue;
      const clean = {};
      for (const [id, o] of Object.entries(map)) {
        if (!o || typeof o !== 'object') continue;
        const e = {};
        if (typeof o.hidden === 'boolean') e.hidden = o.hidden;
        if (typeof o.label === 'string' && o.label) e.label = o.label;
        if (Object.keys(e).length) clean[id] = e;
      }
      overrides[wf] = clean;
    }
    return { overrides };
  } catch (err) {
    return {
      overrides: {},
      error: `control-overrides.json unreadable (${String(err && err.message || err).slice(0, 120)}) — starting empty`
    };
  }
}

// patch: { hidden?: boolean, label?: string|null } — label null clears the
// custom label; an entry that ends up empty drops from the file entirely
function setControlOverride(dir, workflow, id, patch) {
  const { overrides, error } = readControlOverrides(dir);
  const wfMap = overrides[workflow] = overrides[workflow] || {};
  const cur = { ...(wfMap[id] || {}) };
  if (typeof patch.hidden === 'boolean') cur.hidden = patch.hidden;
  if (typeof patch.label === 'string' && patch.label.trim()) cur.label = patch.label.trim();
  else if (patch.label === null) delete cur.label;
  if (Object.keys(cur).length) wfMap[id] = cur; else delete wfMap[id];
  if (!Object.keys(wfMap).length) delete overrides[workflow];
  fs.writeFileSync(path.join(dir, OVERRIDES_FILE), JSON.stringify(overrides, null, 2) + '\n');
  return { overrides, error };
}

function applyControlOverrides(controls, wfOverrides) {
  if (!wfOverrides || !Object.keys(wfOverrides).length) return controls;
  const out = {};
  for (const [k, ctl] of Object.entries(controls)) {
    const o = wfOverrides[controlTargetId(ctl)];
    if (!o) { out[k] = ctl; continue; }
    const c = { ...ctl };
    if (o.hidden === false) delete c.hidden;
    if (o.hidden === true) c.hidden = true;
    if (o.label) c.label = o.label;
    out[k] = c;
  }
  return out;
}

// ---------- WebSocket client ----------
// Electron 43's main process (Node 22+) ships a native global WebSocket —
// preferred when present. The manual RFC 6455 client below stays as the
// tested fallback for older runtimes. ComfyUI's /ws sends JSON events
// (progress) as text and preview frames as binary — both are delivered.
function openWs(url, handlers) {
  return typeof WebSocket === 'function' ? openNativeWs(url, handlers) : openManualWs(url, handlers);
}

function openNativeWs(url, { onMessage, onBinary, onClose } = {}) {
  const ws = new WebSocket(url.replace(/^http/, 'ws'));
  ws.binaryType = 'arraybuffer';   // default 'blob' would force an async read
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try { ws.close(); } catch (_) {}
    onClose && onClose();
  };
  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') {
      try { onMessage && onMessage(JSON.parse(ev.data)); } catch (_) {}
      return;
    }
    if (onBinary) { try { onBinary(Buffer.from(ev.data)); } catch (_) {} }
  };
  ws.onclose = close;
  ws.onerror = close;
  return { close, get open() { return ws.readyState === 1 && !closed; } };
}

// ---------- binary preview frames ----------
// Stock ComfyUI /ws binary message: [4B event type BE][payload]; event 1 =
// preview image, whose payload is [4B format BE (1=jpeg, 2=png)][image bytes].
// The kjnodes / VideoHelperSuite LTX video previewer sends the SAME event 1
// but wraps the image in an extra envelope after the format field:
// [4B always-1][4B frame index][16B Pascal-string node id] — serving those 24
// bytes to an <img> as part of the JPEG is a guaranteed broken icon. The
// image signature is therefore the ground truth for BOTH the strip offset and
// the mime; event-1 payloads with no signature at either offset are dropped
// (comfy.js logs the wire bytes of the first frames per job, so a new
// envelope shape shows up in the log instead of as a broken image).
function sniffImageMime(b) {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  return null;
}
const LTX_ENVELOPE = 24;   // 4B always-1 + 4B frame index + 16B '16p' node id
function parseBinaryPreview(buf) {
  if (!buf || buf.length <= 8) return null;
  if (buf.readUInt32BE(0) !== 1) return null;
  const bytes = buf.subarray(8);
  let mime = sniffImageMime(bytes);
  if (mime) return { mime, bytes };
  if (bytes.length > LTX_ENVELOPE) {
    mime = sniffImageMime(bytes.subarray(LTX_ENVELOPE));
    if (mime) return { mime, bytes: bytes.subarray(LTX_ENVELOPE), envelope: true };
  }
  return null;
}

// Container dimensions (PNG IHDR / JPEG SOF scan) — decode evidence for the
// per-job log without a rasterizer in the main process.
function previewDims(bytes) {
  const b = bytes;
  if (!b || b.length < 4) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b.length >= 24) {
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
      }
      i += 2 + b.readUInt16BE(i + 2);
    }
  }
  return null;
}

// ---------- preview frame throttle ----------
// Sampler frame rate would flood IPC; forward at most one frame per interval
// but ALWAYS end on the newest one: a frame arriving inside the window
// replaces the pending one (older frames are stale — only the latest matters)
// and a trailing timer delivers it when the window closes. Timers are
// injectable for tests. close() cancels the trailing send at job end.
function latestFrameThrottle(send, ms = 250, { setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now } = {}) {
  let last = -Infinity, pending = null, timer = null, closed = false;
  const fire = () => {
    timer = null;
    if (closed || !pending) return;
    const p = pending;
    pending = null;
    last = now();
    send(p);
  };
  const push = (frame) => {
    if (closed || !frame) return;
    const t = now();
    if (!timer && t - last >= ms) { last = t; send(frame); return; }
    pending = frame;                                  // newest replaces older
    if (!timer) timer = setTimer(fire, Math.max(0, ms - (t - last)));
  };
  push.close = () => {
    closed = true;
    pending = null;
    if (timer) { try { clearTimer(timer); } catch (_) {} timer = null; }
  };
  return push;
}

// ---------- reconnect with backoff ----------
// Keeps a receive-only socket alive across server hiccups while active()
// holds — generation uses it so progress/preview survive a ComfyUI restart
// mid-job (completion is already covered by /history polling). setTimer is
// injectable for tests.
function openWsWithRetry(url, handlers = {}, { active = () => true, delays = [1000, 2000, 5000, 10000], setTimer = setTimeout } = {}) {
  let closed = false, ws = null, attempt = 0;
  const connect = () => {
    if (closed || !active()) return;
    ws = openWs(url, {
      onMessage: (m) => { attempt = 0; handlers.onMessage && handlers.onMessage(m); },
      onBinary: handlers.onBinary,
      onClose: () => {
        if (closed || !active()) return;
        const d = delays[Math.min(attempt, delays.length - 1)];
        attempt++;
        handlers.onReconnect && handlers.onReconnect(d, attempt);
        setTimer(connect, d);
      }
    });
  };
  connect();
  return {
    close: () => { closed = true; try { ws && ws.close(); } catch (_) {} },
    get open() { return !closed && !!ws && ws.open; }
  };
}

// ---------- queue cancel ----------
// Clear pending queue entries FIRST (so the next queued job doesn't start the
// moment the running one dies), then interrupt the running job. Queue
// inspection is best-effort — the interrupt fires regardless.
// cfetch(route, { method, body, timeoutMs }) -> Response, comfy.js's helper.
async function cancelAll(cfetch) {
  let cleared = false;
  try {
    const q = await cfetch('/queue', { timeoutMs: 5000 });
    if (q.ok) {
      const j = await q.json();
      if (Array.isArray(j.queue_pending) && j.queue_pending.length) {
        const r = await cfetch('/queue', { method: 'POST', body: { clear: true }, timeoutMs: 5000 });
        cleared = r.ok;
      }
    }
  } catch (_) { /* queue endpoint down — still interrupt */ }
  const i = await cfetch('/interrupt', { method: 'POST', body: {}, timeoutMs: 5000 });
  return { ok: i.ok, interrupted: i.ok, cleared };
}

// ---------- /upload/image ----------
// Multipart POST that puts a local file into ComfyUI's input folder so a
// LoadImage control can point at it. Returns the server-side name (subfolder-
// prefixed when the server nests it) — exactly what the image select expects.
async function uploadImage(base, filePath, fetchFn = fetch) {
  const bytes = fs.readFileSync(filePath);
  const fd = new FormData();
  fd.append('image', new Blob([bytes]), path.basename(filePath));
  fd.append('overwrite', 'true');
  const r = await fetchFn(base + '/upload/image', {
    method: 'POST', body: fd, signal: AbortSignal.timeout(60000)
  });
  if (!r.ok) throw new Error(`upload failed (HTTP ${r.status})`);
  const j = await r.json().catch(() => ({}));
  const name = j.name || path.basename(filePath);
  return { name: j.subfolder ? `${j.subfolder}/${name}` : name };
}

// Manual receive-oriented RFC 6455 client on http+crypto builtins: upgrade
// handshake, unmasked server frames (text/ping/close), fragmented
// continuation, masked pong replies. Kept fully tested — it is the fallback
// if the app ever runs on a WebSocket-less Node again.
function openManualWs(url, { onMessage, onBinary, onClose } = {}) {
  const u = new URL(url);
  const key = crypto.randomBytes(16).toString('base64');
  let socket = null, closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try { socket && socket.destroy(); } catch (_) {}
    onClose && onClose();
  };

  const req = http.request({
    host: u.hostname, port: u.port || 80, path: u.pathname + u.search,
    headers: {
      Connection: 'Upgrade', Upgrade: 'websocket',
      'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': 13
    }
  });
  req.on('error', close);
  req.on('response', close);   // server refused the upgrade
  req.on('upgrade', (_res, sock, head) => {
    if (closed) { sock.destroy(); return; }
    socket = sock;
    sock.on('error', close);
    sock.on('close', close);
    let buf = Buffer.alloc(0);
    let fragments = null;
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (true) {
        if (buf.length < 2) return;
        const fin = (buf[0] & 0x80) !== 0;
        const opcode = buf[0] & 0x0f;
        let len = buf[1] & 0x7f;
        let off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + len) return;
        const payload = buf.subarray(off, off + len);
        buf = buf.subarray(off + len);
        if (opcode === 8) { close(); return; }             // close
        if (opcode === 9) {                                 // ping -> masked pong
          const mask = crypto.randomBytes(4);
          const masked = Buffer.from(payload);
          for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
          try { sock.write(Buffer.concat([Buffer.from([0x8a, 0x80 | masked.length]), mask, masked])); } catch (_) {}
          continue;
        }
        if (opcode === 2) {                                 // binary preview frame
          if (onBinary) { try { onBinary(Buffer.from(payload)); } catch (_) {} }
          continue;
        }
        if (opcode === 10) continue;                        // pong
        if (opcode === 1 && !fin) { fragments = [payload]; continue; }
        if (opcode === 0) {                                 // continuation
          if (fragments) fragments.push(payload);
          if (!fin) continue;
          const whole = Buffer.concat(fragments || [payload]);
          fragments = null;
          deliver(whole);
          continue;
        }
        if (opcode === 1) deliver(payload);
      }
    };
    const deliver = (payload) => {
      try { onMessage && onMessage(JSON.parse(payload.toString('utf8'))); } catch (_) {}
    };
    sock.on('data', onData);
    // frames that rode in on the same packet as the 101 handshake
    if (head && head.length) onData(head);
  });
  req.end();
  return { close, get open() { return !!socket && !closed; } };
}

module.exports = {
  detectComfyLayout, comfyArgs, spawnComfy,
  listWorkflows, loadWorkflow, patchWorkflow, workflowMedia,
  isUiGraph, flattenUiGraph, uiGraphTypes, uiGraphToApi, pickHistoryOutput,
  buildManifest, ensureManifests,
  readPromptPresets, savePromptPreset, renamePromptPreset, deletePromptPreset,
  readControlOverrides, setControlOverride, applyControlOverrides, controlTargetId,
  readControlValues, saveControlValues, clearControlValues, pruneControlValues,
  mediaFileName, videoFileName, objectInfoOptions, objectInfoRoute, fetchTypeInfo,
  openWs, openNativeWs, openManualWs, openWsWithRetry,
  parseBinaryPreview, previewDims, latestFrameThrottle, cancelAll, uploadImage,
  pruneUnchangedValues, diffApiGraphs, listDroppedWires, dryRunGraph
};
