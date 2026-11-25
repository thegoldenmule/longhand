/** Typed access to the Longhand schema's node and mark types. */
import { schema, type MarkTypeName, type NodeTypeName } from '@longhand/schema';
import type { MarkType, NodeType } from 'prosemirror-model';

function node(name: NodeTypeName): NodeType {
  const t = schema.nodes[name];
  if (!t) throw new Error(`schema has no node ${name}`);
  return t;
}

function mark(name: MarkTypeName): MarkType {
  const t = schema.marks[name];
  if (!t) throw new Error(`schema has no mark ${name}`);
  return t;
}

export const nodes = {
  doc: node('doc'),
  paragraph: node('paragraph'),
  heading: node('heading'),
  blockquote: node('blockquote'),
  bullet_list: node('bullet_list'),
  ordered_list: node('ordered_list'),
  list_item: node('list_item'),
  scene_break: node('scene_break'),
  quote_block: node('quote_block'),
  hard_break: node('hard_break'),
  footnote: node('footnote'),
  citation: node('citation'),
} as const;

export const marks = {
  em: mark('em'),
  strong: mark('strong'),
} as const;
