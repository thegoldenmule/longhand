import { docFromJSON } from '@longhand/schema';
import { describe, expect, it } from 'vitest';
import {
  draftToDoc,
  formatForName,
  markdownToDoc,
  parseInline,
  sha256Hex,
  textToDoc,
} from './importDraft';

describe('importing a draft', () => {
  it('parses Markdown blocks and emphasis into the Longhand schema', () => {
    const doc = markdownToDoc(
      [
        '# The Storm',
        '',
        'The rain fell *sideways* on the **harbour**,',
        'and nobody came.',
        '',
        '> A quoted line.',
        '',
        '- one',
        '- two',
        '',
        '3. three',
        '',
        '***',
        '',
        'snake_case stays literal.',
      ].join('\n'),
    );
    const node = docFromJSON(doc);
    expect(node.childCount).toBe(7);
    expect(node.child(0).type.name).toBe('heading');
    expect(node.child(1).textContent).toBe(
      'The rain fell sideways on the harbour, and nobody came.',
    );
    expect(doc.content![1]!.content!.map((t) => t.marks?.[0]?.type ?? null)).toEqual([
      null,
      'em',
      null,
      'strong',
      null,
    ]);
    expect(node.child(2).type.name).toBe('blockquote');
    expect(node.child(3).type.name).toBe('bullet_list');
    expect(node.child(4).attrs.order).toBe(3);
    expect(node.child(5).type.name).toBe('scene_break');
    expect(node.child(6).textContent).toBe('snake_case stays literal.');
  });

  it('keeps plain text literal: blank lines split paragraphs, newlines are hard breaks', () => {
    const doc = docFromJSON(textToDoc('One *two*\nthree\n\n\nFour'));
    expect(doc.childCount).toBe(2);
    expect(doc.child(0).textContent).toBe('One *two*\nthree');
    expect(doc.child(0).child(1).type.name).toBe('hard_break');
  });

  it('always yields a valid document', () => {
    for (const text of ['', '   \n\n', '#', '> ', '**', '- ']) {
      expect(() => draftToDoc(text, 'markdown')).not.toThrow();
      expect(() => draftToDoc(text, 'text')).not.toThrow();
    }
    expect(parseInline('a ** b')).toEqual([{ type: 'text', text: 'a ** b' }]);
  });

  it('reads links and inline code, with emphasis inside link text', () => {
    const link = (href: string) => ({ type: 'link', attrs: { href } });
    expect(
      parseInline('See [the **site**](example.com "Title") and run `make *book*` or `` a`b ``.'),
    ).toEqual([
      { type: 'text', text: 'See ' },
      { type: 'text', text: 'the ', marks: [link('https://example.com')] },
      { type: 'text', text: 'site', marks: [link('https://example.com'), { type: 'strong' }] },
      { type: 'text', text: ' and run ' },
      { type: 'text', text: 'make *book*', marks: [{ type: 'code' }] },
      { type: 'text', text: ' or ' },
      { type: 'text', text: 'a`b', marks: [{ type: 'code' }] },
      { type: 'text', text: '.' },
    ]);
    expect(parseInline('[mail](<mailto:ada@example.com>) [`code`](https://x.org/a_b)')).toEqual([
      { type: 'text', text: 'mail', marks: [link('mailto:ada@example.com')] },
      { type: 'text', text: ' ' },
      { type: 'text', text: 'code', marks: [link('https://x.org/a_b'), { type: 'code' }] },
    ]);
    const doc = docFromJSON(draftToDoc('# A [linked](https://example.com) title', 'markdown'));
    expect(doc.firstChild!.child(1).marks[0]!.attrs.href).toBe('https://example.com');
  });

  it('keeps links the href policy refuses as literal text', () => {
    for (const bad of ['[x](javascript:alert)', '[x](data:text/html,hi)', '[x](/relative)']) {
      expect(parseInline(bad), bad).toEqual([{ type: 'text', text: bad }]);
      expect(() => draftToDoc(bad, 'markdown')).not.toThrow();
    }
  });

  it('guesses the format from the file name and hashes the bytes', async () => {
    expect(formatForName('draft.md')).toBe('markdown');
    expect(formatForName('draft.TXT')).toBe('text');
    expect(formatForName(null)).toBe('text');
    expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});
