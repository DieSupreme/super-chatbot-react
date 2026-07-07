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
});
