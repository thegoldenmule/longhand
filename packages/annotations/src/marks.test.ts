import { schema } from '@longhand/schema';
import { afterEach, describe, expect, it } from 'vitest';
import { harness, settle, type Harness } from '../test-support/fixtures';

const open: Harness[] = [];
afterEach(() => {
  for (const h of open.splice(0)) h.destroy();
  document.body.innerHTML = '';
});

const HREF = 'https://example.com/roofs';

/** The `suggestions` fixture after its first review, with the writer linking and coding words. */
async function formatted(): Promise<Harness> {
  const h = harness('suggestions');
  open.push(h);
  await settle();
  const view = h.handle.view;
  const find = (word: string): number => {
    let at = -1;
    view.state.doc.descendants((n, pos) => {
      if (at < 0 && n.isText && n.text!.includes(word)) at = pos + n.text!.indexOf(word);
    });
    return at;
  };
  const roof = find('the old roof');
  const waited = find('waited');
  // A toolbar press: user activation, then marks only.
  document.dispatchEvent(new Event('pointerdown'));
  view.dispatch(
    view.state.tr
      .addMark(roof, roof + 'the old roof'.length, schema.marks.link!.create({ href: HREF }))
      .addMark(waited, waited + 'waited'.length, schema.marks.code!.create()),
  );
  await h.commit();
  await settle(10);
  return h;
}

describe('annotations over links and inline code', () => {
  it('keeps underlines inside links and code, and ghost text out of them', async () => {
    const h = await formatted();
    const dom = h.handle.view.dom;
    const a = dom.querySelector('a')!;
    expect(a.getAttribute('href')).toBe(HREF);
    expect(a.textContent).toBe('the old roof');
    const inLink = [...a.querySelectorAll('.lh-ann-suggestion')].map((e) => e.textContent);
    expect(inLink).toEqual(expect.arrayContaining(['old', 'roof']));
    const code = dom.querySelector('code')!;
    expect(code.textContent).toBe('waited');
    expect(code.querySelector('.lh-ann-suggestion')?.textContent).toBe('waited');
    // Ghost text is a widget with no marks: never drawn as a link or as code.
    h.controller.focus('sug-adopt');
    const alt = dom.querySelector('.lh-ghost-alt') as HTMLElement;
    expect(alt.textContent).toBe('weathered');
    expect(alt.closest('a, code')).toBeNull();
    const insertion = dom.querySelector('.lh-ghost-insertion') as HTMLElement;
    expect(insertion.closest('a, code')).toBeNull();
    // Formatting did not change any annotation's range or the text.
    expect(
      h.handle
        .getState()
        .doc.textBetween(
          h.controller.localRange('sug-adopt')!.from,
          h.controller.localRange('sug-adopt')!.to,
        ),
    ).toBe('old');
    expect(h.text()).not.toContain('example.com');
  });

  it('traces over a linked word and still resolves it adopted', async () => {
    const h = await formatted();
    expect(h.controller.startTrace('sug-adopt')).toBe(true);
    await settle();
    h.typeText('weathered');
    await h.commit();
    await settle(10);
    const s = h.transport.projectState().annotations.suggestions['sug-adopt']!;
    expect(s.status).toBe('adopted');
    const doc = h.transport.projectState().documents['doc-s']!;
    expect(
      doc.provenance.some(
        (r) => r.class === 'typed-from-suggestion' && r.suggestionId === 'sug-adopt',
      ),
    ).toBe(true);
    // The link mark is formatting: no annotation went stale because of it.
    const stale = Object.values(h.transport.projectState().annotations.suggestions).filter(
      (x) => x.status === 'stale',
    );
    expect(stale.map((x) => x.id)).not.toContain('sug-adopt');
  });
});
