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
// Produces an HTML string injected via dangerouslySetInnerHTML. It is safe
// because tokenization runs on the RAW code and every emitted piece — literal
// text AND the inner text of each token — is escaped with escapeHtml before it
// reaches the output. The only unescaped markup is our own token spans.
//
// Tokenizing on the raw string (not on already-escaped HTML) is what fixes the
// old corruption: escaping first produced entities like &#39; whose '#' and
// digits were then matched as a comment / number, mangling any code containing
// an apostrophe or single-quoted string.
function escapeHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
const KEYWORDS = /^(?:const|let|var|function|return|if|else|for|while|class|new|import|export|from|async|await|def|elif|try|except|catch|throw|true|false|null|undefined|this|public|private|void|int|string|bool)$/;
export function highlight(code) {
  // One pass, priority by alternation order: strings (double/single/backtick,
  // escape-aware, no newline crossing) → line comments (// or #) → identifiers
  // (classified as keyword or left literal) → numbers. A '#' or digits INSIDE a
  // string match the string alt first, so they never start a spurious comment
  // or number.
  const token = /("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`[^`]*`)|((?:\/\/|#)[^\n]*)|([A-Za-z_$][\w$]*)|(\d+\.?\d*)/g;
  let out = '', last = 0, m;
  while ((m = token.exec(code)) !== null) {
    if (m.index > last) out += escapeHtml(code.slice(last, m.index));
    if (m[1]) out += '<span class="tok-str">' + escapeHtml(m[1]) + '</span>';
    else if (m[2]) out += '<span class="tok-com">' + escapeHtml(m[2]) + '</span>';
    else if (m[3]) out += KEYWORDS.test(m[3]) ? '<span class="tok-kw">' + escapeHtml(m[3]) + '</span>' : escapeHtml(m[3]);
    else out += '<span class="tok-num">' + escapeHtml(m[4]) + '</span>';
    last = token.lastIndex;
  }
  if (last < code.length) out += escapeHtml(code.slice(last));
  return out;
}

// ---------- block-level parse ----------
// Splits the source on ``` fences, then parses the text between them. Parsing is
// line-based: an opening fence is a line starting with ```; the closing fence is
// a line that is exactly ``` (trailing whitespace allowed). This means a fence
// body may itself contain ``` on a non-bare line without closing early, and an
// unterminated fence runs to end-of-message instead of swallowing the rest as
// text. Segment kinds: code {lang, fname, raw} · edit {path, content} · text.
function makeCodeSeg(info, raw) {
  if (info === 'edit' || info.startsWith('edit ')) {
    // ```edit path=C:\full\path.js
    const pm = info.match(/path=(.+)$/);
    return { kind: 'edit', path: pm ? pm[1].trim() : '(unknown)', content: raw };
  }
  // info can be "js", "js:app.js", or "app.js"
  let lang = info, fname = null;
  if (info.includes(':')) { [lang, fname] = info.split(':'); fname = fname.trim(); }
  else if (/\.[a-zA-Z0-9]{1,5}$/.test(info)) { fname = info; lang = info.split('.').pop(); }
  if (!fname) fname = guessFilename(lang, raw);
  const safeLang = (lang || 'code').toLowerCase();
  if (!fname) fname = 'snippet.' + extFor(safeLang);
  return { kind: 'code', lang: safeLang, fname, raw };
}
export function parseSegments(src) {
  const segs = [];
  if (!src) return segs;
  const lines = src.split('\n');
  let text = [];         // pending text lines
  const flushText = () => {
    if (text.length) { segs.push({ kind: 'text', text: text.join('\n') }); text = []; }
  };
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(/^```(.*)$/);
    if (!open) { text.push(lines[i]); continue; }
    // opening fence — collect body until a bare ``` line (or end of input)
    flushText();
    const info = open[1].trim();
    const body = [];
    let closed = false;
    let j = i + 1;
    for (; j < lines.length; j++) {
      if (/^```\s*$/.test(lines[j])) { closed = true; break; }
      body.push(lines[j]);
    }
    segs.push(makeCodeSeg(info, body.join('\n')));
    // resume after the closing fence; an unterminated fence consumes to the end
    i = closed ? j : lines.length;
  }
  flushText();
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
