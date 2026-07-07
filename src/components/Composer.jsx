import React, { useRef, useEffect } from 'react';
import { MODELS, contextBudget } from '../models.js';

function estimateTokens(f) {
  if (f.error) return 0;
  if (f.kind === 'text') return Math.ceil((f.content || '').length / 4);  // ~4 chars per token
  if (f.kind === 'image') return 800;                                      // rough per-image cost
  return 0;
}

function AttachBar({ pending, onRemove, model }) {
  if (!pending.length) return null;
  const okFiles = pending.filter(f => !f.error);
  const errFiles = pending.length - okFiles.length;
  const tokens = pending.reduce((s, f) => s + estimateTokens(f), 0);
  const budget = contextBudget(model);
  const tokStr = tokens >= 1000 ? (tokens / 1000).toFixed(1) + 'K' : tokens;
  const modelName = (MODELS.find(m => m.id === model) || {}).label || model;

  let cls = 'attach-summary', txt = `${okFiles.length} file${okFiles.length !== 1 ? 's' : ''} · ~${tokStr} tokens`;
  if (errFiles) txt += ` · ${errFiles} skipped`;
  if (tokens > budget) { cls += ' over'; txt += ` ⚠ may exceed ${modelName} — switch to Gemini/DeepSeek for big inputs`; }
  else if (tokens > budget * 0.7) { cls += ' warn'; txt += ' · getting large'; }

  return (
    <div id="attachBar">
      {pending.map((f, i) => (
        <span key={i} className="attach-chip" title={f.error || undefined}>
          <span>📎 {f.name}{f.error ? ' ⚠' : ''}</span>
          <span className="chip-x" onClick={() => onRemove(i)}>✕</span>
        </span>
      ))}
      <div className={cls}>{txt}</div>
    </div>
  );
}

export default function Composer({ input, setInput, onSend, onStop, isStreaming,
  pending, onRemovePending, onAttach, model, inputRef }) {
  const localRef = useRef(null);
  const ref = inputRef || localRef;

  // autosize the textarea to its content, capped at 160px
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 160) + 'px';
  }, [input, ref]);

  return (
    <>
      <AttachBar pending={pending} onRemove={onRemovePending} model={model} />
      <footer>
        <button className="ghost" title="Attach files" onClick={onAttach}>＋</button>
        <textarea id="input" ref={ref} rows={1} value={input}
          placeholder="Type a message…  (Enter to send · Shift+Enter for newline)"
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!isStreaming) onSend(); }
          }} />
        <button id="send" className={isStreaming ? 'stopping' : ''}
          onClick={() => isStreaming ? onStop() : onSend()}>
          {isStreaming ? 'Stop' : 'Send'}
        </button>
      </footer>
    </>
  );
}
