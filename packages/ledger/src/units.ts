/**
 * Provenance units: one position per text character (UTF-16 code unit) or inline
 * leaf (`hard_break`, `citation`). Matches `provenanceUnits` in `@longhand/schema`.
 *
 * Each unit has a `key` used to compare content exactly (copy snapshots, drops,
 * undo/redo): the character itself for text, or `\u0000type{attrs}` for leaves.
 * Marks are not part of the key.
 */
import { canonicalize, type PMNode } from '@longhand/schema';

/** A unit's position and content key. */
export interface UnitRef {
  pos: number;
  key: string;
}

const LEAF_PREFIX = '\u0000';

/** Content key of an inline leaf node. */
export function leafKey(node: PMNode): string {
  return `${LEAF_PREFIX}${node.type.name}${canonicalize(node.attrs)}`;
}

/** True if a key is a text character. */
export function isTextKey(key: string): boolean {
  return !key.startsWith(LEAF_PREFIX);
}

/** True if a key is a citation node. */
export function isCitationKey(key: string): boolean {
  return key.startsWith(`${LEAF_PREFIX}citation`);
}

/** Text a key contributes to inline text (`hard_break` is `\n`, citations nothing). */
export function keyText(key: string): string {
  if (isTextKey(key)) return key;
  return key.startsWith(`${LEAF_PREFIX}hard_break`) ? '\n' : '';
}

/** Units in `[from, to)` of `doc`, ascending. */
export function unitsBetween(doc: PMNode, from: number, to: number): UnitRef[] {
  const out: UnitRef[] = [];
  if (to <= from) return out;
  doc.nodesBetween(from, to, (node, pos) => {
    if (node.isText) {
      const text = node.text as string;
      const start = Math.max(0, from - pos);
      const end = Math.min(text.length, to - pos);
      for (let i = start; i < end; i++) out.push({ pos: pos + i, key: text[i] as string });
      return false;
    }
    if (node.isInline && node.isLeaf) {
      if (pos >= from && pos < to) out.push({ pos, key: leafKey(node) });
      return false;
    }
    return true;
  });
  return out;
}

/** All units of a node's content, with positions relative to the node's content start `base`. */
export function unitsOfNode(node: PMNode, base: number): UnitRef[] {
  return unitsBetween(node, 0, node.content.size).map((u) => ({ pos: u.pos + base, key: u.key }));
}

/** Count of text-character units in a list. */
export function textUnitCount(units: readonly { key: string }[]): number {
  let n = 0;
  for (const u of units) if (isTextKey(u.key)) n++;
  return n;
}
