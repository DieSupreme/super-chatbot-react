import React from 'react';
import { MODELS, fmtCost } from '../models.js';

export default function HeaderBar({
  model, setModel, keyVal, setKeyVal, keyCompact, setKeyCompact, onSaveKey,
  cost, memory, setMemory, web, setWeb, imageMode, setImageMode,
  onToggleSysPrompt, onToggleSide, onOpenSettings, keyFieldRef,
  view, onToggleView
}) {
  const keyOk = keyVal.trim().startsWith('sk-or-');
  const keyState = keyOk ? 'key ready' : (keyVal ? 'check key' : 'no key');

  return (
    <header>
      <div className="logo">Super Chatbot <small>OPENROUTER · REACT</small></div>
      <select id="model" value={model} onChange={e => setModel(e.target.value)}>
        {MODELS.map(m => <option key={m.id} value={m.id}>{m.label} — {m.desc}</option>)}
      </select>

      {keyCompact ? (
        <button className="ghost" title="API key saved — click to change it"
          onClick={() => { setKeyCompact(false); setTimeout(() => keyFieldRef.current && keyFieldRef.current.focus(), 0); }}>
          Key ✓
        </button>
      ) : (
        <>
          <input id="key" ref={keyFieldRef} type="password" placeholder="Paste sk-or-v1-… key"
            autoComplete="off" spellCheck="false" value={keyVal} onChange={e => setKeyVal(e.target.value)} />
          <span className={'key-state' + (keyOk ? ' ok' : '')}>{keyState}</span>
          <button className="ghost" onClick={onSaveKey}>Save key</button>
        </>
      )}

      <span id="costBadge" title="Cost of this conversation so far">{fmtCost(cost)}</span>

      <label className="chk" title="When on, the model sees the whole conversation. When off, each message is sent with no prior context.">
        <input type="checkbox" checked={memory} onChange={e => setMemory(e.target.checked)} /> Memory
      </label>
      <label className="chk" title="When on, the model can search the web for current information (~$0.005 per search via OpenRouter).">
        <input type="checkbox" checked={web} onChange={e => setWeb(e.target.checked)} /> Web
      </label>
      <label className="chk" title="When on, your message generates an image instead of a text reply.">
        <input type="checkbox" checked={imageMode} onChange={e => setImageMode(e.target.checked)} /> Image
      </label>

      <button className="ghost" onClick={onToggleSysPrompt} title="Set standing instructions for this chat">Instructions</button>
      <button className="ghost" onClick={onToggleSide}>Files</button>
      <button className={'ghost' + (view === 'terminal' ? ' active' : '')} onClick={onToggleView}
        title="Toggle the embedded terminal">{view === 'terminal' ? '💬 Chat' : '⌗ Terminal'}</button>
      <button className="ghost" onClick={onOpenSettings} title="Settings">⚙</button>
    </header>
  );
}
