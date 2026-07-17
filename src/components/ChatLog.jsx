import React, { useState, useMemo, useRef, useEffect, useLayoutEffect } from 'react';
import api from '../api.js';
import { extractText } from '../models.js';
import { Markdown, parseSegments } from '../markdown.jsx';

// ---------- collapsible reasoning block ----------
function ThinkBlock({ text, streaming, open, onToggle }) {
  const bodyRef = useRef(null);
  // keep the reasoning view pinned to its own bottom while it streams
  useEffect(() => {
    if (streaming && open && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [text, streaming, open]);
  return (
    <details className={'think' + (streaming ? ' streaming' : '')} open={open}
      onToggle={e => onToggle(e.currentTarget.open)}>
      <summary><span className="ico">▶</span><span className="lbl">Thinking</span></summary>
      <div className="think-body" ref={bodyRef}>{text}</div>
    </details>
  );
}

// ---------- web-search citations ----------
function Citations({ cits }) {
  const safe = cits.filter(c => {
    try { const u = new URL(c.url); return u.protocol === 'http:' || u.protocol === 'https:'; }
    catch (_) { return false; }
  });
  if (!safe.length) return null;
  return (
    <div className="citations">
      <div className="cit-head">🔎 Sources</div>
      {safe.map((c, i) => {
        let host = c.url; try { host = new URL(c.url).hostname.replace(/^www\./, ''); } catch (_) {}
        return (
          <a key={i} className="cit" href={c.url} target="_blank" rel="noopener noreferrer">
            <span className="cit-n">{i + 1}</span>
            <span className="cit-t">{c.title || host}</span>
            <span className="cit-h">{host}</span>
          </a>
        );
      })}
    </div>
  );
}

// ---------- proposed-edit approve/reject card ----------
function EditCard({ path, content, onToast }) {
  const [state, setState] = useState('idle');   // idle | saved | dismissed
  if (state === 'dismissed') return null;
  const preview = content.length > 4000 ? content.slice(0, 4000) + '\n…(truncated in preview)' : content;
  const apply = async () => {
    const res = await api.writeFile({ path, content });
    if (res.ok) setState('saved');
    else onToast('Could not save: ' + res.error, 'warn');
  };
  return (
    <div className="edit-card">
      <div className="ef">✎ proposed edit → {path}</div>
      <pre>{preview}</pre>
      {state === 'saved'
        ? <div className="actions"><span style={{ color: 'var(--accent-2)', fontSize: 13 }}>✓ Saved (backup made)</span></div>
        : <div className="actions">
            <button onClick={apply}>Apply &amp; save</button>
            <button className="ghost" onClick={() => setState('dismissed')}>Dismiss</button>
          </div>}
    </div>
  );
}

// ---------- generated-image bubble content ----------
function GenImage({ image, prompt, onToast }) {
  const url = `data:${image.mime};base64,${image.b64}`;
  const save = async () => {
    const s = await api.saveImage({ b64: image.b64, mime: image.mime });
    if (s.ok) onToast('Image saved');
  };
  return (
    <>
      <img className="gen-img" src={url} alt={prompt} />
      <div className="gen-actions"><button onClick={save}>Save image</button></div>
    </>
  );
}

// ---------- ComfyUI video (on disk; loaded via IPC on mount) ----------
// Only the path lives in message state; bytes come over IPC as a data: URI
// (CSP allows media-src data:, nothing else).
function VideoMsg({ path, onToast }) {
  const [vid, setVid] = useState(null);      // { b64, mime } | 'missing'
  useEffect(() => {
    let alive = true;
    api.comfy.readVideo(path).then(r => {
      if (alive) setVid(r && r.ok ? { b64: r.b64, mime: r.mime } : 'missing');
    });
    return () => { alive = false; };
  }, [path]);
  if (vid === 'missing') return <span className="err">video not found: {path}</span>;
  if (!vid) return <span className="dots">loading video</span>;
  return (
    <>
      <video className="gen-vid" controls loop src={`data:${vid.mime};base64,${vid.b64}`} />
      <div className="gen-actions">
        <span className="sd-file" title={path}>{path.split(/[\\/]/).pop()}</span>
      </div>
    </>
  );
}

// ---------- live generation card ----------
// A ComfyUI job in flight is a MESSAGE (kind 'gen'): the chat shows the live
// preview image, progress bar and sampler-pass label while the job runs, and
// App replaces this message in place with the final image/video result when
// it lands. One <img> updated in place — frames NEVER append new messages —
// and the card itself subscribes to the preview/progress channels so frame
// churn stays out of the message array. Never persisted (transient by kind).
function GenCard({ m, onToast }) {
  const [progress, setProgress] = useState(null);
  const [preview, setPreview] = useState(null);    // latest frame { b64, mime }
  useEffect(() => {
    const offP = api.comfy.onProgress((d) => { if (!d.done) setProgress(d); });
    const offPrev = api.comfy.onPreview ? api.comfy.onPreview((d) => setPreview(d)) : () => {};
    return () => { offP(); offPrev(); };
  }, []);
  const pct = progress && progress.max ? Math.min(100, Math.round((progress.value / progress.max) * 100)) : null;
  const cancel = async () => {
    if (!window.confirm('Interrupt the running job (and clear any queued jobs)?')) return;
    const r = await api.comfy.cancel();
    if (!r || !r.ok) onToast((r && r.error) || 'Cancel failed', 'warn');
  };
  return (
    <div className="gen-live">
      {preview && (
        <img className="gen-img gen-live-img" alt="live preview"
          src={`data:${preview.mime};base64,${preview.b64}`} />
      )}
      <div className="vid-progress-meta">
        <span>{(progress && progress.phase) || 'queued…'}</span>
        <span>{pct != null ? pct + '%' : ''}{progress ? ' · ' + Math.round(progress.elapsed || 0) + 's' : ''}</span>
      </div>
      <div className="sd-progress"><div className="sd-progress-fill" style={{ width: (pct != null ? pct : 4) + '%' }} /></div>
      <div className="gen-actions">
        <button className="ghost" title="Interrupt the running job and clear the queue" onClick={cancel}>✕ Cancel</button>
      </div>
    </div>
  );
}

// ---------- local SD image (on disk; loaded via IPC on mount) ----------
// Only the file path lives in message state — pixels are fetched when the
// bubble mounts and stay in this component's local state.
function SdImage({ path, prompt, onToast }) {
  const [img, setImg] = useState(null);      // { b64, mime } | 'missing'
  useEffect(() => {
    let alive = true;
    api.sd.readImage(path).then(r => {
      if (alive) setImg(r && r.ok ? { b64: r.b64, mime: r.mime } : 'missing');
    });
    return () => { alive = false; };
  }, [path]);
  if (img === 'missing') return <span className="err">image not found: {path}</span>;
  if (!img) return <span className="dots">loading image</span>;
  const save = async () => {
    const s = await api.saveImage({ b64: img.b64, mime: img.mime });
    if (s.ok) onToast('Image saved');
  };
  return (
    <>
      <img className="gen-img" src={`data:${img.mime};base64,${img.b64}`} alt={prompt} />
      <div className="gen-actions">
        <button onClick={save}>Save a copy</button>
        <span className="sd-file" title={path}>{path.split(/[\\/]/).pop()}</span>
      </div>
    </>
  );
}

// ---------- one message ----------
function MessageBubble({ m, isLatestAi, isStreamingAny, onRetry, onRegenerate, onEditLast, onImageAction, onToast }) {
  const [copied, setCopied] = useState(false);
  const isUser = m.role === 'user';
  // discriminator (old conversations have no `kind`; imagePath marks SD results)
  const isVideo = m.kind === 'video' || (!!m.videoPath && m.kind !== 'chat');
  const isImage = !isVideo && (m.kind === 'image' || (!!m.imagePath && m.kind !== 'chat'));
  const rawText = isUser ? extractText(m.content) : (m.content || '');

  // parse once per content change; segments feed Markdown, the zip bar, and edit cards
  const segments = useMemo(
    () => (!isUser && !m.streaming && !m.error && !m.image && !m.imagePath && !m.imagePending) ? parseSegments(m.content || '') : [],
    [isUser, m.streaming, m.error, m.image, m.imagePath, m.imagePending, m.content]
  );
  const codeFiles = useMemo(() => segments.filter(s => s.kind === 'code'), [segments]);
  const editSegs = useMemo(() => segments.filter(s => s.kind === 'edit'), [segments]);

  const copy = () => navigator.clipboard.writeText(rawText).then(() => {
    setCopied(true); setTimeout(() => setCopied(false), 1200);
  });

  const [zipMsg, setZipMsg] = useState('');
  const saveZip = async () => {
    const files = codeFiles.map(f => ({ name: f.fname, content: f.raw }));
    const r = await api.saveZip({ files, suggestedName: 'super-chatbot-files.zip' });
    if (r.ok) setZipMsg(`Saved ${r.count} files`);
  };

  let body;
  if (m.error) {
    body = <span className="err">{m.error}</span>;
  } else if (m.kind === 'gen') {
    body = <GenCard m={m} onToast={onToast} />;
  } else if (isVideo && m.videoPath) {
    body = <VideoMsg path={m.videoPath} onToast={onToast} />;
  } else if (m.imagePending) {
    body = <span className="dots">generating image</span>;
  } else if (m.image) {
    body = <GenImage image={m.image} prompt={rawText} onToast={onToast} />;
  } else if (m.imagePath) {
    body = <SdImage path={m.imagePath} prompt={rawText} onToast={onToast} />;
  } else if (!isUser && m.streaming) {
    body = m.fresh ? <span className="dots">thinking</span> : <span className="stream-text">{m.content}</span>;
  } else if (!isUser) {
    body = (
      <>
        <Markdown segments={segments} onToast={onToast} />
        {m.stopped && <div className="err" style={{ marginTop: 6 }}>⏹ stopped</div>}
      </>
    );
  } else {
    body = (
      <>
        {rawText}
        {m.attachNames && m.attachNames.length > 0 && (
          <div style={{ marginTop: 6 }}>
            {m.attachNames.map((n, i) => <span key={i} className="attach-chip">📎 {n}</span>)}
          </div>
        )}
      </>
    );
  }

  const showTools = !m.streaming && !m.imagePending && m.kind !== 'gen';

  return (
    <div className={'msg ' + (isUser ? 'user' : 'ai')}>
      <div className="who">{isUser ? 'You' : m.who}</div>
      {!isUser && m.reasoning && (
        <ThinkBlock text={m.reasoning} streaming={!!m.streaming} open={!!m.thinkOpen} onToggle={m.onThinkToggle} />
      )}
      <div className="bubble">{body}</div>

      {!isUser && !m.streaming && !m.error && m.citations && m.citations.length > 0 && <Citations cits={m.citations} />}
      {!isUser && !m.streaming && editSegs.map((s, i) => (
        <EditCard key={i} path={s.path} content={s.content} onToast={onToast} />
      ))}
      {!isUser && !m.streaming && codeFiles.length >= 2 && (
        <div className="zip-bar">
          <span>{zipMsg || `${codeFiles.length} files in this reply`}</span>
          {!zipMsg && <button className="zip-btn" onClick={saveZip}>Download all as .zip</button>}
        </div>
      )}

      {showTools && (
        <div className="m-tools">
          <button onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
          {!isUser && !isImage && !isVideo && isLatestAi && <button onClick={() => !isStreamingAny && onRetry()}>↻ Retry</button>}
        </div>
      )}

      {/* video messages route to ComfyUI via the panel — never to chat */}
      {isVideo && !isStreamingAny && m.genParams && (
        <div className="msg-actions">
          <button title="Same settings, new seed" onClick={() => onImageAction(m, 'regenerate')}>↻ Regenerate</button>
          <button title="Exact reproduction with the original seed" onClick={() => onImageAction(m, 'reuse-seed')}>♻ Reuse seed</button>
          <button title="Load these settings into the panel" onClick={() => onImageAction(m, 'reuse-settings')}>⚙ Reuse settings</button>
        </div>
      )}

      {/* chat messages regenerate via OpenRouter — unchanged */}
      {!isUser && !isImage && !isVideo && isLatestAi && !isStreamingAny && (
        <div className="msg-actions">
          <button onClick={onRegenerate}>↻ Regenerate</button>
          <button onClick={onEditLast}>✎ Edit my message</button>
        </div>
      )}

      {/* image messages route to Forge via the SD panel — never to chat.
          Replay actions need the stored params; inpaint replay additionally
          needs the in-memory mask (gone after an app restart). */}
      {isImage && !isStreamingAny && (
        <div className="msg-actions">
          {m.genParams && (m.genParams.mode !== 'inpaint' || m.genParams.maskData) && <>
            <button title="Same settings, new seed" onClick={() => onImageAction(m, 'regenerate')}>↻ Regenerate</button>
            <button title="Exact reproduction with the original seed" onClick={() => onImageAction(m, 'reuse-seed')}>♻ Reuse seed</button>
          </>}
          {m.genParams &&
            <button title="Load these settings into the panel" onClick={() => onImageAction(m, 'reuse-settings')}>⚙ Reuse settings</button>}
          <button onClick={() => onImageAction(m, 'img2img')}>→ img2img</button>
          <button onClick={() => onImageAction(m, 'inpaint')}>→ inpaint</button>
          <button title="Upload to ComfyUI and use as the video start image"
            onClick={() => onImageAction(m, 'use-start-image')}>🎬 start image</button>
        </div>
      )}
    </div>
  );
}

// ---------- empty states ----------
function EmptyState({ variant, onStarter }) {
  if (variant === 'new') {
    return (
      <div className="empty">
        <h2>New chat</h2>
        <p>Type below to begin. This conversation saves automatically once you send your first message.</p>
      </div>
    );
  }
  const starters = [
    { label: 'Write a debounce function', p: 'Write a vanilla JavaScript debounce function with a clear example.' },
    { label: 'Explain Electron IPC', p: "Explain how Electron's main process and renderer communicate via IPC." },
    { label: 'Ideas for a game launcher', p: 'Give me 5 ideas to improve a Steam-style game launcher UI.' }
  ];
  return (
    <div className="empty">
      <h2>Welcome to Super Chatbot</h2>
      <p><b>1.</b> Paste your OpenRouter key up top and click <b>Save key</b> — it's stored encrypted and remembered.</p>
      <p><b>2.</b> Pick a model, type below, and send. Attach files with <b>＋</b>, drag &amp; drop (zips unpack automatically), or paste a screenshot with <b>Ctrl+V</b>.</p>
      <p><b>3.</b> Flip on <b>Web</b> for current-events questions, and use <b>Files</b> to let the bot propose changes to files you choose — every save asks you first.</p>
      <div className="starters">
        {starters.map((s, i) => <button key={i} className="starter" onClick={() => onStarter(s.p)}>{s.label}</button>)}
      </div>
    </div>
  );
}

// ---------- the scrolling log ----------
export default function ChatLog({ messages, emptyVariant, onStarter, isStreaming,
  onRetryLast, onRegenerate, onEditLast, onImageAction, onToast }) {
  const logRef = useRef(null);
  const atBottomRef = useRef(true);
  const [showScrollBtn, setShowScrollBtn] = useState(false);

  const onScroll = () => {
    const el = logRef.current;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    atBottomRef.current = atBottom;
    setShowScrollBtn(!atBottom);
  };

  // follow the stream if the user was already at the bottom
  useLayoutEffect(() => {
    const el = logRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const lastAiUid = [...messages].reverse().find(m => m.role === 'assistant' && !m.streaming && !m.error)?.uid;

  return (
    <>
      <div id="log" ref={logRef} onScroll={onScroll}>
        {!messages.length
          ? <EmptyState variant={emptyVariant} onStarter={onStarter} />
          : messages.map(m => (
              <MessageBubble key={m.uid} m={m}
                isLatestAi={m.uid === lastAiUid}
                isStreamingAny={isStreaming}
                onRetry={onRetryLast} onRegenerate={onRegenerate} onEditLast={onEditLast}
                onImageAction={onImageAction}
                onToast={onToast} />
            ))}
      </div>
      {showScrollBtn && (
        <button id="scrollBtn" title="Scroll to latest"
          onClick={() => { const el = logRef.current; el.scrollTop = el.scrollHeight; }}>↓</button>
      )}
    </>
  );
}
