// App.jsx — the state container. Everything the vanilla build kept in module-
// level `let` variables lives here as React state; everything it did with
// direct DOM writes is now derived rendering.
import React, { useState, useRef, useEffect, useCallback } from 'react';
import api from './api.js';
import { MODELS, DEFAULT_SETTINGS, modelLabel, extractText } from './models.js';
import HeaderBar from './components/HeaderBar.jsx';
import SettingsModal from './components/SettingsModal.jsx';
import ConvoSidebar from './components/ConvoSidebar.jsx';
import ChatLog from './components/ChatLog.jsx';
import Composer from './components/Composer.jsx';
import { SidePanel, SysPromptBar, Toasts, DropZone } from './components/Panels.jsx';
import TerminalDock from './components/TerminalDock.jsx';
import SdPanel from './components/SdPanel.jsx';
import { toPersistedMessage } from './persist.js';

let uidCounter = 0;
const newUid = () => 'm_' + (++uidCounter) + '_' + Date.now().toString(36);
const newConvoId = () => 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

export default function App() {
  // ---------- key ----------
  const [keyVal, setKeyVal] = useState('');
  const [keyCompact, setKeyCompact] = useState(false);
  const keyFieldRef = useRef(null);

  // ---------- model / toggles / settings ----------
  const [model, setModel] = useState(MODELS[0].id);
  const [memory, setMemory] = useState(true);
  const [web, setWeb] = useState(false);
  const [imageMode, setImageMode] = useState(false);
  const [settings, setSettings] = useState({ ...DEFAULT_SETTINGS });
  const [showSettings, setShowSettings] = useState(false);
  const [showSysBar, setShowSysBar] = useState(false);
  const [sideOpen, setSideOpen] = useState(false);

  // ---------- local Stable Diffusion panel ----------
  // Mounted lazily on first open (no Forge probing until then), then kept
  // alive across toggles so form state and the process log survive.
  const [sdOpen, setSdOpen] = useState(false);
  const [sdMounted, setSdMounted] = useState(false);
  const toggleSd = () => setSdOpen(o => { if (!o) setSdMounted(true); return !o; });

  // ---------- embedded terminal ----------
  // 'chat' | 'terminal'. The terminal is a full-area view that replaces the chat
  // body. It's mounted lazily (no pty spawns until first opened) and, once
  // mounted, kept alive across toggles via CSS so the session persists.
  const [view, setView] = useState('chat');
  const [termMounted, setTermMounted] = useState(false);
  const toggleView = () => setView(v => {
    const next = v === 'terminal' ? 'chat' : 'terminal';
    if (next === 'terminal') setTermMounted(true);
    return next;
  });

  // ---------- conversation ----------
  const [convos, setConvos] = useState([]);
  const [currentId, setCurrentId] = useState(null);
  const [currentTitle, setCurrentTitle] = useState('New chat');
  const [currentCost, setCurrentCost] = useState(0);
  const [sysPrompt, setSysPrompt] = useState('');
  const [emptyVariant, setEmptyVariant] = useState('welcome');

  // ---------- messages ----------
  // Kept in a ref-mirrored state so async completion code always reads the
  // latest list without stale-closure bugs.
  const [messages, _setMessages] = useState([]);
  const messagesRef = useRef([]);
  // Eager updates: the next array is computed from the ref immediately, so
  // async code (persist, finalize) that runs right after a setMessages call
  // always sees the new list — React's own functional updaters run later.
  const setMessages = useCallback((updater) => {
    const next = typeof updater === 'function' ? updater(messagesRef.current) : updater;
    messagesRef.current = next;
    _setMessages(next);
  }, []);

  // ---------- composer ----------
  const [input, setInput] = useState('');
  const [pending, setPending] = useState([]);   // staged attachments
  const inputRef = useRef(null);
  const searchRef = useRef(null);

  // ---------- streaming ----------
  const [isStreaming, setIsStreaming] = useState(false);
  const isStreamingRef = useRef(false);
  const activeReqRef = useRef(null);
  const reqCounter = useRef(0);
  const chunkBuf = useRef({});     // requestId -> { delta, reasoning }
  const rafId = useRef(0);
  const setStreaming = (on) => { isStreamingRef.current = on; setIsStreaming(on); };

  // ---------- allow-list / toasts / drop overlay ----------
  const [allowPaths, setAllowPaths] = useState([]);
  const [toasts, setToasts] = useState([]);
  const [dropShow, setDropShow] = useState(false);

  const toast = useCallback((msg, kind) => {
    const id = ++uidCounter;
    setToasts(t => [...t, { id, msg, kind }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 3200);
  }, []);

  // refs that mirror values async handlers need to read fresh
  const stateRef = useRef({});
  stateRef.current = { keyVal, model, memory, web, imageMode, settings, sysPrompt,
    currentId, currentTitle, currentCost, pending, view };

  // ================= boot =================
  useEffect(() => {
    (async () => {
      try {
        const s = await api.getSettings();
        let merged = { ...DEFAULT_SETTINGS };
        if (s && s.ok && s.settings) merged = { ...merged, ...s.settings };
        setSettings(merged);
        if (merged.defaultModel) setModel(merged.defaultModel);
      } catch (_) {}
      const r = await api.loadKey();
      if (r.ok && r.key) { setKeyVal(r.key); setKeyCompact(true); }
      refreshConvos();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refreshConvos() {
    const r = await api.convoList();
    if (r.ok) setConvos(r.list);
  }

  // ================= streaming chunk pipeline =================
  // Chunks arrive faster than React should re-render, so they're buffered in
  // a ref and flushed once per animation frame.
  useEffect(() => {
    const off = api.onChunk(({ requestId, delta, reasoning }) => {
      const b = chunkBuf.current[requestId] || (chunkBuf.current[requestId] = { delta: '', reasoning: '' });
      if (delta) b.delta += delta;
      if (reasoning) b.reasoning += reasoning;
      if (!rafId.current) rafId.current = requestAnimationFrame(flushChunks);
    });
    return () => { if (typeof off === 'function') off(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function flushChunks() {
    rafId.current = 0;
    const buf = chunkBuf.current;
    chunkBuf.current = {};
    if (!Object.keys(buf).length) return;
    setMessages(prev => prev.map(m => {
      const b = m.requestId != null ? buf[m.requestId] : null;
      if (!b || !m.streaming) return m;
      const upd = { ...m };
      if (b.reasoning) {
        upd.reasoning = (upd.reasoning || '') + b.reasoning;
        if (upd.thinkOpen === undefined) upd.thinkOpen = true;   // expanded while streaming
      }
      if (b.delta) {
        if (upd.fresh) { upd.fresh = false; upd.thinkOpen = false; }  // first content collapses the think block
        upd.content = (upd.content || '') + b.delta;
      }
      return upd;
    }));
  }
  function flushChunksNow() {
    if (rafId.current) { cancelAnimationFrame(rafId.current); rafId.current = 0; }
    rafId.current = 0;
    flushChunks();
  }

  // per-message think-block toggle needs a stable handler attached to the message
  function attachThinkToggle(m) {
    if (m.role !== 'assistant') return m;
    return {
      ...m,
      onThinkToggle: (open) => setMessages(prev => prev.map(x => x.uid === m.uid ? { ...x, thinkOpen: open } : x))
    };
  }

  // ================= persistence =================
  // Same storage shape as the vanilla build, so existing conversations.json
  // files load unchanged: {id, title, model, messages:[{role,content}], cost, sysPrompt, memory}
  async function persistConvo(msgs) {
    const st = stateRef.current;
    const id = st.currentId || newConvoId();
    if (!st.currentId) setCurrentId(id);
    stateRef.current.currentId = id;
    const persistable = msgs
      .filter(m => !m.error && !m.streaming && !m.imagePending && (m.role === 'user' || (m.content && m.content.length)))
      .map(toPersistedMessage);
    await api.convoSave({
      id, title: st.currentTitle, model: st.model,
      messages: persistable, cost: st.currentCost, sysPrompt: st.sysPrompt, memory: st.memory
    });
    refreshConvos();
  }

  // ================= conversations =================
  function startNewChat() {
    if (isStreamingRef.current) { toast('Stop the current response first', 'warn'); return; }
    setCurrentId(null); setCurrentTitle('New chat'); setCurrentCost(0);
    setSysPrompt(''); setMemory(true);
    setPending([]); setMessages([]);
    setEmptyVariant('new');
  }

  async function openConvo(id) {
    if (isStreamingRef.current) { toast('Stop the current response first', 'warn'); return; }
    const r = await api.convoGet(id);
    if (!r.ok) return;
    const c = r.convo;
    setCurrentId(c.id); setCurrentTitle(c.title); setCurrentCost(c.cost || 0);
    setSysPrompt(c.sysPrompt || '');
    setMemory(c.memory !== undefined ? c.memory : true);
    if (c.model) setModel(c.model);
    const who = modelLabel(c.model || stateRef.current.model);
    setMessages((c.messages || []).map(m => attachThinkToggle({
      uid: newUid(), role: m.role, content: m.content,
      who: m.videoPath ? 'ComfyUI' : m.imagePath ? 'Stable Diffusion' : who,
      attachNames: m.attachNames,
      reasoning: m.reasoning,
      citations: m.citations,
      imagePath: m.imagePath,
      videoPath: m.videoPath,
      // discriminator with backwards compat: files written before `kind`
      // existed mark SD results only by imagePath; plain messages are chat
      kind: m.kind || (m.videoPath ? 'video' : m.imagePath ? 'image' : 'chat'),
      genParams: m.genParams,
      thinkOpen: m.reasoning ? false : undefined
    })));
    refreshConvos();
  }

  async function renameConvo(id, name) {
    const g = await api.convoGet(id);
    if (g.ok) { g.convo.title = name; await api.convoSave(g.convo); }
    if (id === stateRef.current.currentId) setCurrentTitle(name);
    refreshConvos();
  }

  async function deleteConvo(id) {
    if (isStreamingRef.current) { toast('Stop the current response first', 'warn'); return; }
    await api.convoDelete(id);
    if (id === stateRef.current.currentId) startNewChat();
    refreshConvos();
  }

  // ================= settings =================
  function updateSettings(patch) {
    setSettings(prev => {
      const next = { ...prev, ...patch };
      api.saveSettings(next);
      return next;
    });
    if (patch.defaultModel) setModel(patch.defaultModel);
  }

  // ================= key =================
  async function saveKey() {
    const k = keyVal.trim();
    if (!k.startsWith('sk-or-')) { toast('Paste a valid key first — it starts with sk-or-v1-', 'warn'); return; }
    const r = await api.saveKey(k);
    if (r.ok) { toast(r.encrypted ? 'API key saved (encrypted)' : 'API key saved'); setKeyCompact(true); }
    else toast('Could not save the key: ' + (r.error || 'unknown error'), 'warn');
  }

  // ================= allow-list =================
  async function refreshAllow() { const r = await api.allowList(); if (r.ok) setAllowPaths(r.paths); }
  async function addAllow() { const r = await api.allowAdd(); if (r.ok) setAllowPaths(r.paths); }
  async function removeAllow(p) { const r = await api.allowRemove(p); if (r.ok) setAllowPaths(r.paths); }
  function toggleSide() { setSideOpen(o => { if (!o) refreshAllow(); return !o; }); }

  // ================= attachments =================
  async function pickFiles() {
    const r = await api.pickFiles();
    if (r.ok && r.files.length) setPending(p => [...p, ...r.files]);
  }
  const removePending = (i) => setPending(p => p.filter((_, x) => x !== i));

  // paste an image from the clipboard (Ctrl+V anywhere)
  useEffect(() => {
    let pasteCount = 0;
    const onPaste = (e) => {
      const items = (e.clipboardData || {}).items || [];
      for (const item of items) {
        if (item.type && item.type.startsWith('image/')) {
          e.preventDefault();
          const mimeType = item.type;              // capture now — item is invalid inside async onload
          const file = item.getAsFile();
          if (!file) continue;
          const reader = new FileReader();
          reader.onload = () => {
            const result = String(reader.result || '');
            const b64 = result.includes(',') ? result.slice(result.indexOf(',') + 1) : '';
            if (!b64) { toast('Could not read the pasted image', 'warn'); return; }
            const ext = (mimeType.split('/')[1] || 'png').replace('jpeg', 'jpg');
            setPending(p => [...p, { name: `pasted-${++pasteCount}.${ext}`, path: '(clipboard)', kind: 'image', mime: mimeType, data: b64 }]);
          };
          reader.readAsDataURL(file);
        }
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [toast]);

  // drag and drop files onto the window
  useEffect(() => {
    let dragDepth = 0;
    const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
    // Overlay bookkeeping listens in the CAPTURE phase: the SD source box and
    // the terminal dock stopPropagation() on drag/drop to claim the payload for
    // themselves, which starves bubble-phase listeners and left the overlay
    // stuck. Only the attach-to-chat drop handler stays in bubble phase, so a
    // child that claims a drop still keeps it out of the chat attach bar.
    const enter = (e) => {
      e.preventDefault();
      if (stateRef.current.view === 'terminal') return;
      if (hasFiles(e)) { dragDepth++; setDropShow(true); }
    };
    const over = (e) => {
      if (stateRef.current.view === 'terminal') return;
      e.preventDefault();
    };
    const leave = (e) => {
      e.preventDefault();
      if (stateRef.current.view === 'terminal') return;
      // relatedTarget null = the cursor left the window; hide unconditionally
      // (fast exits can skip intermediate dragleaves and strand the counter)
      dragDepth = e.relatedTarget === null ? 0 : Math.max(0, dragDepth - 1);
      if (dragDepth === 0) setDropShow(false);
    };
    const reset = () => { dragDepth = 0; setDropShow(false); };
    const dropHide = (e) => { e.preventDefault(); reset(); };
    const drop = async (e) => {
      e.preventDefault();
      if (stateRef.current.view === 'terminal') return;
      const dropped = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
      if (!dropped.length) return;
      // Electron 32+ removed File.path; webUtils.getPathForFile is the supported way.
      const paths = dropped.map(f => api.getPathForFile(f)).filter(Boolean);
      if (paths.length) {
        const r = await api.readFiles(paths);
        if (r.ok) setPending(p => [...p, ...r.files]);
      } else {
        for (const f of dropped) {
          if (f.type && f.type.startsWith('image/')) {
            const reader = new FileReader();
            reader.onload = () => {
              const result = String(reader.result || '');
              const b64 = result.includes(',') ? result.slice(result.indexOf(',') + 1) : '';
              if (b64) setPending(p => [...p, { name: f.name, path: '(dropped)', kind: 'image', mime: f.type, data: b64 }]);
            };
            reader.readAsDataURL(f);
          }
        }
      }
    };
    window.addEventListener('dragenter', enter, true);
    window.addEventListener('dragleave', leave, true);
    window.addEventListener('drop', dropHide, true);
    window.addEventListener('dragend', reset, true);
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter, true);
      window.removeEventListener('dragleave', leave, true);
      window.removeEventListener('drop', dropHide, true);
      window.removeEventListener('dragend', reset, true);
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // keyboard shortcuts
  useEffect(() => {
    const onKey = (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key === 'n') { e.preventDefault(); startNewChat(); }
      else if (mod && e.key === 'k') { e.preventDefault(); searchRef.current && searchRef.current.focus(); }
      else if (mod && e.key === ',') { e.preventDefault(); setShowSettings(s => !s); }
      else if (e.key === 'Escape') {
        setShowSettings(s => {
          if (s) return false;
          if (isStreamingRef.current && activeReqRef.current != null) api.stopChat(activeReqRef.current);
          return s;
        });
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ================= system prompt sent to the model =================
  function systemPrompt(allowList) {
    const st = stateRef.current;
    let s = 'You are Super Chatbot, a helpful assistant running in a desktop app. ';
    s += `Today's date is ${new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}. Your training data has a cutoff, so products, models, or events newer than that may be real even if you don't recognize them. If the user provides screenshots, documents, or other evidence of something recent, treat it as accurate rather than insisting it doesn't exist or is fake. `;
    s += 'When you output a complete file the user might want to save, start its code fence with the filename, like ```js:app.js or ```app.js, so the app can offer a Save button. For multiple files, give each its own labelled code block. ';
    if (st.sysPrompt && st.sysPrompt.trim()) {
      s += '\n\nThe user has given these standing instructions for this conversation — follow them throughout:\n' + st.sysPrompt.trim();
    }
    if (allowList.length) {
      s += '\n\nThe user has authorised you to edit these specific files:\n';
      allowList.forEach(p => s += ' - ' + p + '\n');
      s += '\nWhen you want to change one of these files, output the COMPLETE new file contents inside a fenced block that starts with a line like:\n';
      s += '```edit path=<exact full path>\n<full new file contents>\n```\n';
      s += 'Use the exact path from the list. The app will show the user your proposed change and ask them to confirm before saving. Only propose edits to files in that list.';
    }
    return s;
  }

  // ================= sending =================
  async function sendMessage() {
    const st = stateRef.current;
    const text = input.trim();
    const key = st.keyVal.trim();
    if (!text && !st.pending.length) return;
    if (!key.startsWith('sk-or-')) { toast('Paste your OpenRouter key first', 'warn'); return; }

    // Image generation mode
    if (st.imageMode) {
      if (!text) { toast('Type what you want the image to show', 'warn'); return; }
      if (!messagesRef.current.length) {
        setCurrentTitle('🖼 ' + text.slice(0, 38));
        stateRef.current.currentTitle = '🖼 ' + text.slice(0, 38);
      }
      const userMsg = { uid: newUid(), role: 'user', content: text };
      const base = [...messagesRef.current, userMsg];
      setMessages(base);
      setInput('');
      await generateImageTurn(text, key, base);
      return;
    }

    // build the model message content (text + attachments)
    const parts = [];
    if (text) parts.push({ type: 'text', text });
    const attachNames = [];
    for (const f of st.pending) {
      if (f.error) continue;
      attachNames.push(f.name);
      if (f.kind === 'image') {
        const mime = (f.mime && f.mime.includes('/')) ? f.mime : 'image/png';
        const data = (f.data || '').replace(/^data:[^,]*,/, '').trim();
        if (!data) continue;
        parts.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${data}` } });
      } else if (f.kind === 'text') {
        parts.push({ type: 'text', text: `\n\n--- attached file: ${f.name} (${f.path}) ---\n${f.content}` });
      }
    }
    const userContent = parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts;

    if (!messagesRef.current.length && text) {
      const t = text.slice(0, 40) + (text.length > 40 ? '…' : '');
      setCurrentTitle(t);
      stateRef.current.currentTitle = t;
    }

    const userMsg = { uid: newUid(), role: 'user', content: userContent, attachNames };
    const base = [...messagesRef.current, userMsg];
    setMessages(base);
    setPending([]);
    setInput('');
    await runCompletion(base);
  }

  // Runs a completion against `base` (whose last entry must be a user turn),
  // streams into a placeholder assistant message, then finalizes it in place.
  async function runCompletion(base) {
    const st = stateRef.current;
    const key = st.keyVal.trim();
    const allowR = await api.allowList();

    // Memory ON: whole conversation. Memory OFF: only the latest user turn.
    const persistable = base.filter(m => !m.error && !m.imagePending);
    let convoForModel = persistable;
    if (!st.memory) {
      let i = persistable.length - 1;
      while (i >= 0 && persistable[i].role !== 'user') i--;
      convoForModel = i >= 0 ? [persistable[i]] : persistable.slice(-1);
    }
    const msgs = [
      { role: 'system', content: systemPrompt(allowR.ok ? allowR.paths : []) },
      ...convoForModel.map(m => ({ role: m.role, content: m.content }))
    ];

    const requestId = ++reqCounter.current;
    activeReqRef.current = requestId;
    setStreaming(true);

    const placeholder = attachThinkToggle({
      uid: newUid(), requestId, role: 'assistant', content: '',
      streaming: true, fresh: true, who: modelLabel(st.model)
    });
    setMessages([...base, placeholder]);

    try {
      const r = await api.sendChat({
        key, model: st.model, messages: msgs, requestId,
        web: st.web, temp: st.settings.temp, maxTok: st.settings.maxTok
      });
      flushChunksNow();   // drain any buffered chunks before finalizing

      let nextCost = st.currentCost;
      setMessages(prev => prev.map(m => {
        if (m.requestId !== requestId) return m;
        if (!r.ok) {
          return { ...m, streaming: false, fresh: false,
            error: `Error${r.status ? ' ' + r.status : ''}: ${(r.error || 'unknown').slice(0, 300)}` };
        }
        if (r.stopped) {
          // user hit Stop — keep whatever streamed, mark it
          return { ...m, streaming: false, fresh: false, thinkOpen: false, stopped: true };
        }
        return { ...m, streaming: false, fresh: false, thinkOpen: false,
          content: r.full, citations: r.citations || [], reasoning: m.reasoning };
      }));

      if (r.ok && typeof r.cost === 'number') {
        nextCost = st.currentCost + r.cost;
        setCurrentCost(nextCost);
        stateRef.current.currentCost = nextCost;
      }
      if (r.ok) await persistConvo(messagesRef.current);
    } catch (err) {
      setMessages(prev => prev.map(m => m.requestId === requestId
        ? { ...m, streaming: false, fresh: false, error: 'Something went wrong: ' + String(err && err.message || err).slice(0, 200) }
        : m));
    } finally {
      activeReqRef.current = null;
      setStreaming(false);
      inputRef.current && inputRef.current.focus();
    }
  }

  // ================= image generation turn =================
  async function generateImageTurn(prompt, key, base) {
    const st = stateRef.current;
    setStreaming(true);
    const uid = newUid();
    setMessages([...base, { uid, role: 'assistant', content: '', imagePending: true, who: modelLabel(st.model) }]);
    try {
      const r = await api.generateImage({ key, model: st.settings.imgModel, prompt, aspect: st.settings.imgAspect });
      if (!r.ok) {
        setMessages(prev => prev.map(m => m.uid === uid
          ? { ...m, imagePending: false, error: `Image error${r.status ? ' ' + r.status : ''}: ${(r.error || 'unknown').slice(0, 300)}` }
          : m));
      } else {
        // a text marker goes in history (images aren't re-sent on reload, but the turn is recorded)
        setMessages(prev => prev.map(m => m.uid === uid
          ? { ...m, imagePending: false, image: { b64: r.b64, mime: r.mime }, content: `[generated image: ${prompt}]` }
          : m));
        if (typeof r.cost === 'number') {
          const nextCost = st.currentCost + r.cost;
          setCurrentCost(nextCost);
          stateRef.current.currentCost = nextCost;
        }
        await persistConvo(messagesRef.current);
      }
    } catch (err) {
      setMessages(prev => prev.map(m => m.uid === uid
        ? { ...m, imagePending: false, error: 'Image generation failed: ' + String(err && err.message || err).slice(0, 200) }
        : m));
    } finally {
      setStreaming(false);
      inputRef.current && inputRef.current.focus();
    }
  }

  // ================= local SD results =================
  // The panel hands back {path, prompt, seed, genParams}; the image lives on
  // disk and the message carries the path plus the FULL generation params
  // (kind:'image' discriminates it from chat for Regenerate routing).
  async function appendSdImage({ path, prompt, seed, genParams }) {
    if (!messagesRef.current.length) {
      const t = '🎨 ' + prompt.slice(0, 38);
      setCurrentTitle(t);
      stateRef.current.currentTitle = t;
    }
    // kind is the MEDIA; genParams.backend records who made it (forge |
    // comfy) so Regenerate replays against the right backend
    const viaComfy = genParams && genParams.backend === 'comfy';
    setMessages([...messagesRef.current, {
      uid: newUid(), role: 'assistant', who: viaComfy ? 'ComfyUI' : 'Stable Diffusion',
      content: `[${viaComfy ? 'image' : 'SD image'}: ${prompt}]` + (seed != null ? ` (seed ${seed})` : ''),
      imagePath: path, kind: 'image', genParams
    }]);
    await persistConvo(messagesRef.current);
  }

  // video results: same shape as image results, kind 'video' + videoPath
  async function appendVideo({ path, prompt, seed, genParams }) {
    if (!messagesRef.current.length) {
      const t = '🎬 ' + (prompt || 'video').slice(0, 38);
      setCurrentTitle(t);
      stateRef.current.currentTitle = t;
    }
    setMessages([...messagesRef.current, {
      uid: newUid(), role: 'assistant', who: 'ComfyUI',
      content: `[video: ${prompt || genParams.workflow}]` + (seed != null ? ` (seed ${seed})` : ''),
      videoPath: path, kind: 'video', genParams
    }]);
    await persistConvo(messagesRef.current);
  }

  // image/video message actions route to the generation panel, never to
  // OpenRouter. The panel mounts lazily and the ComfyUI/Forge bodies mount on
  // target switch, so: open, request the target, retry until the needed
  // control function registers.
  const sdControlRef = useRef(null);
  const withSdControl = (target, fnName, call) => {
    setSdMounted(true); setSdOpen(true);
    let switched = false;
    const attempt = (n) => {
      const c = sdControlRef.current;
      if (c && c.showTarget && !switched) { switched = true; c.showTarget(target); }
      // body-specific functions exist only while that body is mounted, so
      // their presence doubles as "the right body is showing"
      if (c && typeof c[fnName] === 'function') { call(c); return; }
      if (n < 40) setTimeout(() => attempt(n + 1), 50);
    };
    attempt(0);
  };
  function onImageAction(m, action) {
    if (!m) return;
    // any still image can seed the video workflow: upload to ComfyUI's input
    // folder and point the video panel's image control at it
    if (action === 'use-start-image') {
      if (!m.imagePath) { toast('No image file stored on this message', 'warn'); return; }
      withSdControl({ media: 'video' }, 'comfyUseStartImage', c => c.comfyUseStartImage(m.imagePath));
      return;
    }
    const gp = m.genParams;
    // kind is the media; the producing backend decides where replays go.
    // Messages saved before `backend` existed: video was always ComfyUI,
    // images were always Forge.
    const viaComfy = m.kind === 'video' || (gp && gp.backend === 'comfy');
    if (viaComfy && (action === 'regenerate' || action === 'reuse-seed' || action === 'reuse-settings')) {
      const target = m.kind === 'video' ? { media: 'video' }
        : { media: 'image', backend: 'comfy', workflow: gp && gp.workflow };
      if (action === 'regenerate') withSdControl(target, 'comfyRegenerate', c => c.comfyRegenerate(gp));
      else if (action === 'reuse-seed') withSdControl(target, 'comfyRegenerate', c => c.comfyRegenerate(gp, { keepSeed: true }));
      else withSdControl(target, 'comfyLoadSettings', c => c.comfyLoadSettings(gp));
      return;
    }
    if (m.kind === 'video') return;
    const forge = { media: 'image', backend: 'forge' };
    if (action === 'regenerate') withSdControl(forge, 'regenerate', c => c.regenerate(gp));
    else if (action === 'reuse-seed') withSdControl(forge, 'regenerate', c => c.regenerate(gp, { keepSeed: true }));
    else if (action === 'reuse-settings') withSdControl(forge, 'loadSettings', c => c.loadSettings(gp));
    // img2img / inpaint always go to Forge — any image is just a pixel source
    else if (action === 'img2img') withSdControl(forge, 'sendImage', c => c.sendImage(m.imagePath, 'img2img'));
    else if (action === 'inpaint') withSdControl(forge, 'sendImage', c => c.sendImage(m.imagePath, 'inpaint'));
  }

  // images already in this conversation, offered as img2img sources
  const convoImages = [];
  for (const m of messages) {
    if (m.imagePath) convoImages.push({ label: m.imagePath.split(/[\\/]/).pop(), path: m.imagePath });
    else if (m.image && m.image.b64) convoImages.push({ label: 'generated image', b64: m.image.b64, mime: m.image.mime });
    else if (Array.isArray(m.content)) {
      for (const p of m.content) {
        const mm = p.type === 'image_url' && p.image_url && String(p.image_url.url).match(/^data:([^;]+);base64,(.+)$/);
        if (mm) convoImages.push({ label: `attached image ${convoImages.length + 1}`, b64: mm[2], mime: mm[1] });
      }
    }
  }

  // ================= regenerate / retry / edit-last =================
  async function regenerate() {
    if (isStreamingRef.current) return;
    let msgs = messagesRef.current;
    if (msgs.length && msgs[msgs.length - 1].role === 'assistant') msgs = msgs.slice(0, -1);
    setMessages(msgs);
    await persistConvo(msgs);
    await runCompletion(msgs);
  }

  async function editLastUserMessage() {
    if (isStreamingRef.current) return;
    const msgs = messagesRef.current;
    let idx = msgs.length - 1;
    while (idx >= 0 && msgs[idx].role !== 'user') idx--;
    if (idx < 0) return;
    const msg = msgs[idx];
    setInput(extractText(msg.content));
    const trimmed = msgs.slice(0, idx);
    setMessages(trimmed);
    await persistConvo(trimmed);
    if (msg.attachNames?.length) toast('Image attachments were not restored — re-attach files if needed', 'warn');
    inputRef.current && inputRef.current.focus();
  }

  function stopStream() {
    if (activeReqRef.current != null) api.stopChat(activeReqRef.current);
  }

  // ================= render =================
  return (
    <div className="app">
      <HeaderBar
        model={model} setModel={setModel}
        keyVal={keyVal} setKeyVal={setKeyVal}
        keyCompact={keyCompact} setKeyCompact={setKeyCompact}
        onSaveKey={saveKey} keyFieldRef={keyFieldRef}
        cost={currentCost}
        memory={memory} setMemory={(v) => { setMemory(v); stateRef.current.memory = v; if (stateRef.current.currentId) persistConvo(messagesRef.current); }}
        web={web} setWeb={setWeb}
        imageMode={imageMode} setImageMode={setImageMode}
        onToggleSysPrompt={() => setShowSysBar(s => !s)}
        onToggleSide={toggleSide}
        sdOpen={sdOpen} onToggleSd={toggleSd}
        onOpenSettings={() => setShowSettings(true)}
        view={view} onToggleView={toggleView}
      />

      <SettingsModal open={showSettings} onClose={() => setShowSettings(false)}
        settings={settings} update={updateSettings} />

      <SysPromptBar open={showSysBar} value={sysPrompt}
        onChange={(v) => { setSysPrompt(v); stateRef.current.sysPrompt = v; }}
        onBlur={() => { if (stateRef.current.currentId) persistConvo(messagesRef.current); }} />

      <div className="body-row" style={{ display: view === 'terminal' ? 'none' : 'flex' }}>
        <ConvoSidebar convos={convos} currentId={currentId}
          onNew={startNewChat} onOpen={openConvo} onRename={renameConvo} onDelete={deleteConvo}
          searchRef={searchRef} />

        <ChatLog messages={messages} emptyVariant={emptyVariant}
          onStarter={(p) => { setInput(p); inputRef.current && inputRef.current.focus(); }}
          isStreaming={isStreaming}
          onRetryLast={regenerate} onRegenerate={regenerate} onEditLast={editLastUserMessage}
          onImageAction={onImageAction}
          onToast={toast} />

        {sdMounted && <SdPanel open={sdOpen} onToast={toast} onImage={appendSdImage} onVideo={appendVideo}
          convoImages={convoImages} controlRef={sdControlRef} />}

        <SidePanel open={sideOpen} paths={allowPaths} onAdd={addAllow} onRemove={removeAllow} />
      </div>

      {termMounted && (
        <div className="term-view" style={{ display: view === 'terminal' ? 'flex' : 'none' }}>
          <TerminalDock active={view === 'terminal'} onToast={toast} />
        </div>
      )}

      {view !== 'terminal' && (
        <Composer input={input} setInput={setInput}
          onSend={sendMessage} onStop={stopStream} isStreaming={isStreaming}
          pending={pending} onRemovePending={removePending} onAttach={pickFiles}
          model={model} inputRef={inputRef} />
      )}

      <DropZone show={dropShow} />
      <Toasts toasts={toasts} />
    </div>
  );
}
