import { describe, expect, it } from 'vitest';
import { DocJSONSchema, EMPTY_DOC_JSON, docFromJSON, emptyDoc, schema } from './document';

describe('document schema', () => {
  it('has exactly the contracted node and mark types', () => {
    expect(Object.keys(schema.nodes).sort()).toEqual(
      [
        'blockquote',
        'bullet_list',
        'citation',
        'doc',
        'footnote',
        'hard_break',
        'heading',
        'list_item',
        'ordered_list',
        'paragraph',
        'quote_block',
        'scene_break',
        'text',
      ].sort(),
    );
    expect(Object.keys(schema.marks).sort()).toEqual(['em', 'strong']);
  });

  it('round-trips a document using every node type', () => {
    const json = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Title' }] },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Hello ', marks: [{ type: 'strong' }] },
            { type: 'text', text: 'world', marks: [{ type: 'em' }] },
            { type: 'hard_break' },
            { type: 'citation', attrs: { sourceId: 's1', locator: 'p. 3' } },
            { type: 'footnote', content: [{ type: 'text', text: 'A note.' }] },
          ],
        },
        { type: 'scene_break' },
        {
          type: 'blockquote',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Q' }] }],
        },
        {
          type: 'bullet_list',
          content: [
            {
              type: 'list_item',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }],
            },
          ],
        },
        {
          type: 'ordered_list',
          attrs: { order: 3 },
          content: [{ type: 'list_item', content: [{ type: 'paragraph' }] }],
        },
        {
          type: 'quote_block',
          attrs: { sourceId: 's1', clippingId: 'c1', locator: null },
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Clipped.' }] }],
        },
      ],
    };
    const node = docFromJSON(json);
    expect(node.toJSON()).toEqual(json);
    expect(DocJSONSchema.safeParse(json).success).toBe(true);
  });

  it('rejects invalid documents', () => {
    const bad = [
      { type: 'paragraph' },
      { type: 'doc', content: [] },
      { type: 'doc', content: [{ type: 'heading', attrs: { level: 4 } }] },
      {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'footnote', content: [{ type: 'footnote' }] }] },
        ],
      },
      { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'citation' }] }] },
      { type: 'doc', content: [{ type: 'quote_block', content: [{ type: 'paragraph' }] }] },
      {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'link' }] }] },
        ],
      },
      { type: 'doc', content: [{ type: 'scene_break', content: [{ type: 'paragraph' }] }] },
    ];
    for (const json of bad) {
      expect(() => docFromJSON(json), JSON.stringify(json)).toThrow();
      expect(DocJSONSchema.safeParse(json).success).toBe(false);
    }
  });

  it('empty doc is one empty paragraph and is frozen', () => {
    expect(emptyDoc().toJSON()).toEqual({ type: 'doc', content: [{ type: 'paragraph' }] });
    expect(Object.isFrozen(EMPTY_DOC_JSON)).toBe(true);
    expect(Object.isFrozen(EMPTY_DOC_JSON.content)).toBe(true);
  });

  it('serializes to DOM specs without a DOM', () => {
    const cite = schema.nodes.citation!.create({ sourceId: 's1', locator: 'p. 2' });
    expect(cite.type.spec.toDOM?.(cite)).toEqual([
      'span',
      { 'data-citation': '', 'data-source-id': 's1', 'data-locator': 'p. 2' },
    ]);
    expect(cite.textContent).toBe('');
  });
});
