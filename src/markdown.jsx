// Markdown for AI replies, rebuilt the React way: instead of building an HTML
// string and innerHTML-ing it (the vanilla approach), the source is parsed
// into a segment tree and rendered as React elements. Copy/Save buttons are
// real components with their own state — no codeRegistry, no event re-wiring.
import React, { useState, useMemo } from 'react';
import api from './api.js';

// ---------- filename helpers (ported 1:1 from the vanilla build) ----------
export function guessFilename(lang, code) {
  // a leading comment naming the file: // app.js   or   # main.py   or   /* style.css */
  const first = code.split('\n')[0].trim();
  const m = first.match(/^(?:\/\/|#|<!--|\/\*)\s*([\w.\-]+\.[a-zA-Z0-9]{1,5})\s*(?:-->|\*\/)?$/);
  return m ? m[1] : null;
}
export function extFor(lang) {
  const map = { javascript:'js', js:'js', typescript:'ts', python:'py', py:'py', html:'html',
    css:'css', json:'json', java:'java', cpp:'cpp', c:'c', csharp:'cs', go:'go', rust:'rs',
    ruby:'rb', php:'php', bash:'sh', shell:'sh', sh:'sh', yaml:'yml', xml:'xml', sql:'sql', markdown:'md' };
  return map[lang] || 'txt';
}

// ---------- light syntax tint ----------
// Produces an HTML string from *escaped* code, exactly like the vanilla build.
// Injected via dangerouslySetInnerHTML — safe because escapeHtml runs first,
// and the only markup added afterwards is our own token spans.
function escapeHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
export function highlight(code) {
  let h = escapeHtml(code);
  h = h.replace(/(&quot;.*?&quot;|&#39;.*?&#39;|`[^`]*`)/g, '<span class="tok-str">$1</span>');
  h = h.replace(/((?:\/\/|#).*?)(\n|$)/g, '<span class="tok-com">$1</span>$2');
  h = h.replace(/\b(const|let|var|function|return|if|else|for|while|class|new|import|export|from|async|await|def|elif|try|except|catch|throw|true|false|null|undefined|this|public|private|void|int|string|bool)\b/g, '<span class="tok-kw">$1</span>');
  h = h.replace(/\b(\d+\.?\d*)\b/g, '<span class="tok-num">$1</span>');
  return h;
}

// ---------- block-level parse ----------
// Splits the source on ``` fences first, then parses the text between them.
// Segment kinds: code {lang, fname, raw} · edit {path, content} · text blocks.
export function parseSegments(src) {
  const segs = [];
  if (!src) return segs;
  const re = /```([^\n`]*)\n([\s\S]*?)```/g;
  let last = 0, m;
  while ((m = re.exec(src)) !== null) {
    if (m.index > last) segs.push({ kind: 'text', text: src.slice(last, m.index) });
    const info = m[1].trim();
    const raw = m[2].replace(/\n$/, '');
    if (info === 'edit' || info.startsWith('edit ')) {
      // ```edit path=C:\full\path.js
      const pm = info.match(/path=(.+)$/);
      segs.push({ kind: 'edit', path: pm ? pm[1].trim() : '(unknown)', content: raw });
    } else {
      // info can be "js", "js:app.js", or "app.js"
      let lang = info, fname = null;
      if (info.includes(':')) { [lang, fname] = info.split(':'); fname = fname.trim(); }
      else if (/\.[a-zA-Z0-9]{1,5}$/.test(info)) { fname = info; lang = info.split('.').pop(); }
      if (!fname) fname = guessFilename(lang, raw);
      const safeLang = (lang || 'code').toLowerCase();
      if (!fname) fname = 'snippet.' + extFor(safeLang);
      segs.push({ kind: 'code', lang: safeLang, fname, raw });
    }
    last = re.lastIndex;
  }
  if (last < src.length) segs.push({ kind: 'text', text: src.slice(last) });
  return segs;
}

// Parse a text segment into blocks: h1–h3, ul, ol, p (lines joined with <br>).
function parseTextBlocks(text) {
  const blocks = [];
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    let m;
    if ((m = line.match(/^(#{1,3}) (.*)$/))) {
      blocks.push({ type: 'h' + m[1].length, text: m[2] }); i++; continue;
    }
    if (/^[-*] /.test(line)) {
      const items = [];
      while (i < lines.length && /^[-*] /.test(lines[i])) { items.push(lines[i].replace(/^[-*]\s/, '')); i++; }
      blocks.push({ type: 'ul', items }); continue;
    }
    if (/^\d+\. /.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+\. /.test(lines[i])) { items.push(lines[i].replace(/^\d+\.\s/, '')); i++; }
      blocks.push({ type: 'ol', items }); continue;
    }
    // paragraph: consecutive non-empty, non-block lines
    const para = [];
    while (i < lines.length && lines[i].trim() &&
           !/^(#{1,3}) /.test(lines[i]) && !/^[-*] /.test(lines[i]) && !/^\d+\. /.test(lines[i])) {
      para.push(lines[i]); i++;
    }
    blocks.push({ type: 'p', lines: para });
  }
  return blocks;
}

// ---------- inline parse: **bold**, `code`, [text](https://…) ----------
function Inline({ text }) {
  const nodes = [];
  const re = /(`[^`\n]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\(https?:[^)]+\))/g;
  let last = 0, m, k = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    if (m[1]) nodes.push(<code key={k++} className="inline">{m[1].slice(1, -1)}</code>);
    else if (m[2]) nodes.push(<strong key={k++}>{m[2].slice(2, -2)}</strong>);
    else if (m[3]) {
      const lm = m[3].match(/^\[([^\]]+)\]\((https?:[^)]+)\)$/);
      // target=_blank → main process setWindowOpenHandler routes it to the default browser
      nodes.push(<a key={k++} href={lm[2]} target="_blank" rel="noopener noreferrer">{lm[1]}</a>);
    }
    last = re.lastIndex;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return <>{nodes}</>;
}

// Paragraph lines joined with <br> (single newlines inside a paragraph)
function Para({ lines }) {
  return (
    <p>
      {lines.map((l, i) => (
        <React.Fragment key={i}>{i > 0 && <br />}<Inline text={l} /></React.Fragment>
      ))}
    </p>
  );
}

// ---------- code block with Copy / Save ----------
export function CodeBlock({ fname, raw, onToast }) {
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  const html = useMemo(() => highlight(raw), [raw]);

  const copy = () => navigator.clipboard.writeText(raw).then(() => {
    setCopied(true); setTimeout(() => setCopied(false), 1200);
  });
  const save = async () => {
    const r = await api.saveAs({ name: fname, content: raw });
    if (r.ok) { setSaved(true); setTimeout(() => setSaved(false), 1200); }
    else if (r.error !== 'cancelled' && onToast) onToast('Could not save: ' + r.error, 'warn');
  };

  return (
    <div className="codeblock">
      <div className="cb-head">
        <span className="cb-lang">{fname}</span>
        <span className="cb-actions">
          <button className="cb-save" onClick={save}>{saved ? 'Saved' : 'Save'}</button>
          <button className="cb-copy" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
        </span>
      </div>
      <pre><code dangerouslySetInnerHTML={{ __html: html }} /></pre>
    </div>
  );
}

// ---------- top-level renderer ----------
// Pass pre-parsed segments (via useMemo in the bubble) to avoid re-parsing.
export function Markdown({ segments, onToast }) {
  return (
    <div className="md">
      {segments.map((seg, si) => {
        if (seg.kind === 'code') return <CodeBlock key={si} fname={seg.fname} raw={seg.raw} onToast={onToast} />;
        if (seg.kind === 'edit') {
          // The interactive Apply/Dismiss card renders below the bubble; inside
          // the flow we show the proposal as a labelled, read-only block.
          return (
            <div key={si} className="codeblock">
              <div className="cb-head"><span className="cb-lang">✎ proposed edit → {seg.path}</span></div>
              <pre><code>{seg.content}</code></pre>
            </div>
          );
        }
        return parseTextBlocks(seg.text).map((b, bi) => {
          const key = si + '-' + bi;
          if (b.type === 'h1') return <h1 key={key}><Inline text={b.text} /></h1>;
          if (b.type === 'h2') return <h2 key={key}><Inline text={b.text} /></h2>;
          if (b.type === 'h3') return <h3 key={key}><Inline text={b.text} /></h3>;
          if (b.type === 'ul') return <ul key={key}>{b.items.map((it, i) => <li key={i}><Inline text={it} /></li>)}</ul>;
          if (b.type === 'ol') return <ol key={key}>{b.items.map((it, i) => <li key={i}><Inline text={it} /></li>)}</ol>;
          return <Para key={key} lines={b.lines} />;
        });
      })}
    </div>
  );
}
