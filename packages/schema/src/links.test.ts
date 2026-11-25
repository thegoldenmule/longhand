import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { docFromJSON, schema, type PMNodeJSON } from './document';
import { isAllowedHref, LINK_HREF_MAX_CHARS, normalizeHref, pastedLinkHref } from './links';

const linked = (href: unknown, text = 'here'): PMNodeJSON => ({
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [{ type: 'text', text, marks: [{ type: 'link', attrs: { href } }] }],
    },
  ],
});

describe('href policy', () => {
  it('keeps http, https and mailto links, lowercasing the scheme', () => {
    expect(normalizeHref('https://example.com/a?b=c#d')).toBe('https://example.com/a?b=c#d');
    expect(normalizeHref('  HTTP://Example.com  ')).toBe('http://Example.com');
    expect(normalizeHref('mailto:ada@example.com?subject=Hi')).toBe(
      'mailto:ada@example.com?subject=Hi',
    );
    expect(normalizeHref('https://example.com:8443/x')).toBe('https://example.com:8443/x');
    expect(normalizeHref('<https://example.com>')).toBe('https://example.com');
  });

  it('turns bare domains into https and bare addresses into mailto', () => {
    expect(normalizeHref('example.com')).toBe('https://example.com');
    expect(normalizeHref('www.example.co.uk/path?q=1')).toBe('https://www.example.co.uk/path?q=1');
    expect(normalizeHref('example.com:8080/x')).toBe('https://example.com:8080/x');
    expect(normalizeHref('//example.com/x')).toBe('https://example.com/x');
    expect(normalizeHref('ada@example.com')).toBe('mailto:ada@example.com');
    expect(normalizeHref('bücher.de')).toBe('https://bücher.de');
  });

  it('rejects every other scheme and anything that is not a link', () => {
    for (const bad of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      ' javascript:alert(1)',
      'java\tscript:alert(1)',
      '\u0000javascript:alert(1)',
      'javascript://example.com/%0Aalert(1)',
      'data:text/html,<b>x</b>',
      'vbscript:msgbox',
      'file:///etc/passwd',
      'ftp://example.com',
      'chrome://settings',
      'blob:https://example.com/x',
      '/relative/path',
      './x',
      '#top',
      '?q=1',
      'localhost:3000',
      'https://',
      'https:example.com',
      'https://user@example.com',
      'https://bank.example@evil.example',
      'https://exa mple.com',
      'https://example.com\\@evil.example',
      'mailto:',
      'hello',
      'e.g.',
      'Mr.S',
      '',
      '   ',
    ]) {
      expect(normalizeHref(bad), bad).toBeNull();
      expect(isAllowedHref(bad), bad).toBe(false);
    }
    expect(normalizeHref(`https://example.com/${'a'.repeat(LINK_HREF_MAX_CHARS)}`)).toBeNull();
    expect(normalizeHref(42 as unknown as string)).toBeNull();
  });

  it('percent-encodes characters unsafe in HTML attributes and Markdown', () => {
    expect(normalizeHref('https://example.com/"><script>`')).toBe(
      'https://example.com/%22%3E%3Cscript%3E%60',
    );
  });

  it('is idempotent, and a stored href is its own normalization', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), (s) => {
        const once = normalizeHref(s);
        if (once === null) return true;
        return normalizeHref(once) === once && isAllowedHref(once);
      }),
    );
    for (const s of ['example.com', 'ada@example.com', '//x.org', 'HTTPS://A.B/"']) {
      const once = normalizeHref(s) as string;
      expect(normalizeHref(once)).toBe(once);
    }
    expect(isAllowedHref('example.com')).toBe(false);
    expect(isAllowedHref('https://example.com')).toBe(true);
  });

  it('takes pasted text for a link only when it plainly is one', () => {
    expect(pastedLinkHref(' https://example.com/x ')).toBe('https://example.com/x');
    expect(pastedLinkHref('www.example.com')).toBe('https://www.example.com');
    expect(pastedLinkHref('mailto:ada@example.com')).toBe('mailto:ada@example.com');
    expect(pastedLinkHref('example.com')).toBeNull();
    expect(pastedLinkHref('Mr.Smith')).toBeNull();
    expect(pastedLinkHref('see https://example.com')).toBeNull();
    expect(pastedLinkHref('javascript:alert(1)')).toBeNull();
  });
});

describe('link and code marks', () => {
  it('parse and validate links in document JSON', () => {
    const doc = docFromJSON(linked('https://example.com'));
    const mark = doc.firstChild!.firstChild!.marks[0]!;
    expect(mark.type.name).toBe('link');
    expect(mark.attrs).toEqual({ href: 'https://example.com' });
    for (const bad of ['javascript:alert(1)', 'example.com', '', null, 3]) {
      expect(() => docFromJSON(linked(bad)), String(bad)).toThrow();
    }
    expect(() => schema.marks.link!.create({ href: 'javascript:alert(1)' })).toThrow();
  });

  it('render links with rel="noopener noreferrer"', () => {
    const mark = schema.marks.link!.create({ href: 'https://example.com' });
    expect(mark.type.spec.toDOM?.(mark, true)).toEqual([
      'a',
      { href: 'https://example.com', rel: 'noopener noreferrer', target: '_blank' },
      0,
    ]);
  });

  it('keep links non-inclusive and let code exclude em and strong but not links', () => {
    const { link, em, strong, code } = schema.marks;
    expect(link!.spec.inclusive).toBe(false);
    const href = link!.create({ href: 'https://example.com' });
    const set = code!.create().addToSet(em!.create().addToSet([]));
    expect(set.map((m) => m.type.name)).toEqual(['code']);
    expect(
      em!
        .create()
        .addToSet([code!.create()])
        .map((m) => m.type.name),
    ).toEqual(['code']);
    expect(
      strong!
        .create()
        .addToSet([code!.create()])
        .map((m) => m.type.name),
    ).toEqual(['code']);
    expect(href.addToSet([code!.create()]).map((m) => m.type.name)).toEqual(['link', 'code']);
    expect(
      em!
        .create()
        .addToSet([href, strong!.create()])
        .map((m) => m.type.name),
    ).toEqual(['link', 'em', 'strong']);
    const both = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'x', marks: [{ type: 'em' }, { type: 'code' }] }],
        },
      ],
    };
    expect(() => docFromJSON(both)).toThrow();
  });

  it('parse links from HTML only when the href is allowed', () => {
    const rule = schema.marks.link!.spec.parseDOM![0]!;
    const el = (href: string) => ({ getAttribute: () => href }) as unknown as HTMLElement;
    const getAttrs = rule.getAttrs as (dom: HTMLElement) => unknown;
    expect(rule.tag).toBe('a[href]');
    expect(getAttrs(el('example.com'))).toEqual({ href: 'https://example.com' });
    expect(getAttrs(el('javascript:alert(1)'))).toBe(false);
    expect(getAttrs(el('/relative'))).toBe(false);
    expect(schema.marks.code!.spec.parseDOM).toEqual([{ tag: 'code' }]);
  });

  it('keep existing documents byte-identical', () => {
    const json = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'a', marks: [{ type: 'em' }, { type: 'strong' }] },
            { type: 'text', text: 'b', marks: [{ type: 'strong' }] },
          ],
        },
      ],
    };
    expect(docFromJSON(json).toJSON()).toEqual(json);
  });
});
