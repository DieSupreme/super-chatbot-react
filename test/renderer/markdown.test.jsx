import { describe, it, expect } from 'vitest';
import { parseSegments, guessFilename, highlight } from '../../src/markdown.jsx';

describe('parseSegments', () => {
  it('parses code blocks with filename', () => {
    const segs = parseSegments('```js:app.js\nconst x = 1;\n```');
    expect(segs).toHaveLength(1);
    expect(segs[0].kind).toBe('code');
    expect(segs[0].fname).toBe('app.js');
    expect(segs[0].raw).toBe('const x = 1;');
  });

  it('parses edit blocks', () => {
    const segs = parseSegments('```edit path=C:\\proj\\a.js\nnew\n```');
    expect(segs[0].kind).toBe('edit');
    expect(segs[0].path).toBe('C:\\proj\\a.js');
  });

  it('a fence body containing ``` on a non-bare line does not close early', () => {
    // model explaining fence syntax: the inner ```js is part of the body
    const segs = parseSegments('```md\nUse ```js for a code block\nmore text\n```');
    const code = segs.filter(s => s.kind === 'code');
    expect(code).toHaveLength(1);
    expect(code[0].raw).toBe('Use ```js for a code block\nmore text');
  });

  it('an unterminated fence runs to end of message instead of dropping to text', () => {
    const segs = parseSegments('intro\n\n```js\nconst x = 1;\nconst y = 2;');
    expect(segs.some(s => s.kind === 'code')).toBe(true);
    const code = segs.find(s => s.kind === 'code');
    expect(code.raw).toBe('const x = 1;\nconst y = 2;');
    // the leading text is preserved as its own segment
    expect(segs.some(s => s.kind === 'text' && s.text.includes('intro'))).toBe(true);
  });
});

describe('guessFilename', () => {
  it('reads leading comment filename', () => {
    expect(guessFilename('js', '// app.js\nconst x = 1')).toBe('app.js');
  });
});

describe('highlight', () => {
  it('escapes HTML before adding spans', () => {
    const html = highlight('<script>alert(1)</script>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('renders a single-quoted string without splitting the apostrophe entity', () => {
    const html = highlight("const s = 'hi';");
    // the whole quoted string is one tok-str with an intact &#39; entity
    expect(html).toContain('<span class="tok-str">&#39;hi&#39;</span>');
    // no spurious comment (from the # in &#39;) and no number (from the 39)
    expect(html).not.toContain('tok-com');
    expect(html).not.toContain('tok-num');
    expect(html).toContain('<span class="tok-kw">const</span>');
  });

  it('still tints real numbers and line comments', () => {
    const html = highlight('x = 42 // note');
    expect(html).toContain('<span class="tok-num">42</span>');
    expect(html).toContain('<span class="tok-com">// note</span>');
  });

  it('a # inside a string is not treated as a comment', () => {
    const html = highlight('c = "#ff0000"');
    expect(html).toContain('<span class="tok-str">&quot;#ff0000&quot;</span>');
    expect(html).not.toContain('tok-com');
  });
});
