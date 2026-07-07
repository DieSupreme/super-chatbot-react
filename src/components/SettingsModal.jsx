import React from 'react';
import { MODELS, IMG_MODELS, ASPECTS } from '../models.js';

export default function SettingsModal({ open, onClose, settings, update }) {
  if (!open) return null;
  return (
    <div id="settingsPanel" onClick={e => { if (e.target.id === 'settingsPanel') onClose(); }}>
      <div className="settings-inner">
        <div className="settings-head">Settings <button className="ghost" onClick={onClose}>Done</button></div>

        <label className="set-row">Default model
          <select value={settings.defaultModel}
            onChange={e => update({ defaultModel: e.target.value })}>
            <option value="">(remember last used)</option>
            {MODELS.map(m => <option key={m.id} value={m.id}>{m.label} — {m.desc}</option>)}
          </select>
        </label>

        <label className="set-row">Temperature <span className="set-val">{Number(settings.temp).toFixed(1)}</span>
          <input type="range" min="0" max="2" step="0.1" value={settings.temp}
            onChange={e => update({ temp: parseFloat(e.target.value) })} />
        </label>

        <label className="set-row">Max response tokens <span className="set-val">{settings.maxTok}</span>
          <input type="range" min="512" max="16384" step="512" value={settings.maxTok}
            onChange={e => update({ maxTok: parseInt(e.target.value) })} />
        </label>

        <label className="set-row">Image model
          <select value={settings.imgModel} onChange={e => update({ imgModel: e.target.value })}>
            {IMG_MODELS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </label>

        <label className="set-row">Image aspect ratio
          <select value={settings.imgAspect} onChange={e => update({ imgAspect: e.target.value })}>
            {ASPECTS.map(a => <option key={a} value={a}>{a === '1:1' ? 'Square (1:1)' : a === '16:9' ? 'Landscape (16:9)' : a === '9:16' ? 'Portrait (9:16)' : a === 'auto' ? 'Auto' : a}</option>)}
          </select>
        </label>

        <div className="set-note">Settings are saved on this device and apply to new messages.</div>
      </div>
    </div>
  );
}
