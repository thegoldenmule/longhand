/**
 * Decorations for the annotation layer: underlines for the spans cards point at,
 * the active card's highlight, and proposal diff previews. Positions are in the
 * document's ledger version (from `ProjectState`); the controller hands them to
 * `editor.setDecorations(layer, decorations, version)`, which maps them onto the
 * local document. Ghost text is drawn by the trace plugin.
 */
import type { LayerDecoration } from '@longhand/editor';
import type { PMNode } from '@longhand/schema';
import { ghostDescriptionId } from './ghost';
import type { Card, CardOf } from './model';

/** UI state that changes how decorations look. */
export interface DecorationUi {
  /** The card the writer clicked (highlighted, proposal preview shown). */
  activeId: string | null;
  /** The card under the pointer (proposal preview shown). */
  hoverId: string | null;
}

function marker(doc: Document, className: string, label: string, id: string): HTMLElement {
  const el = doc.createElement('span');
  el.className = className;
  el.setAttribute('contenteditable', 'false');
  el.setAttribute('aria-hidden', 'true');
  el.setAttribute('data-lh-ghost', '');
  el.dataset.annId = id;
  el.style.userSelect = 'none';
  el.textContent = label;
  return el;
}

function inline(
  from: number,
  to: number,
  className: string,
  id: string,
  extra: Record<string, string> = {},
): LayerDecoration | null {
  if (to <= from) return null;
  return {
    kind: 'inline',
    from,
    to,
    attrs: { class: className, 'data-ann-id': id, ...extra },
    spec: { annotationId: id },
  };
}

function widget(
  pos: number,
  id: string,
  className: string,
  label: string,
  side = 0,
): LayerDecoration {
  return {
    kind: 'widget',
    pos,
    side,
    toDOM: (view) => marker(view.dom.ownerDocument, className, label, id),
    spec: { annotationId: id, key: `${className}:${id}:${pos}`, ignoreSelection: true, marks: [] },
  };
}

/** Node decorations for each top-level node fully inside `[from, to]`. */
function nodeRanges(
  doc: PMNode | null,
  from: number,
  to: number,
): Array<{ from: number; to: number }> {
  if (!doc) return [];
  const out: Array<{ from: number; to: number }> = [];
  doc.forEach((node, offset) => {
    const start = offset;
    const end = offset + node.nodeSize;
    if (start >= from && end <= to) out.push({ from: start, to: end });
  });
  return out;
}

function proposalDecorations(
  card: CardOf<'proposal'>,
  doc: PMNode | null,
  preview: boolean,
  active: boolean,
): LayerDecoration[] {
  const p = card.data;
  const id = card.id;
  const out: Array<LayerDecoration | null> = [];
  const base = `lh-prop lh-prop-${p.kind}${active ? ' lh-ann-active' : ''}`;
  switch (p.kind) {
    case 'move': {
      if (!p.source || p.insertAt === null) break;
      const { from, to } = p.source;
      if (!preview) {
        out.push(inline(from, to, `${base} lh-prop-mark`, id));
        break;
      }
      if (p.span.unit === 'sentence') out.push(inline(from, to, `${base} lh-prop-source`, id));
      else
        for (const r of nodeRanges(doc, from, to))
          out.push({
            kind: 'node',
            from: r.from,
            to: r.to,
            attrs: { class: `${base} lh-prop-source-block`, 'data-ann-id': id },
            spec: { annotationId: id },
          });
      out.push(
        widget(
          p.insertAt,
          id,
          `lh-prop-drop${p.span.unit === 'sentence' ? '' : ' lh-prop-drop-block'}`,
          'move here',
          p.destination.position === 'before' ? 1 : -1,
        ),
      );
      break;
    }
    case 'cut': {
      if (!p.range) break;
      const { from, to } = p.range;
      const inlineCut = p.target.kind === 'anchor' || p.target.span.unit === 'sentence';
      if (!preview) {
        out.push(inline(from, to, `${base} lh-prop-mark`, id));
        break;
      }
      if (inlineCut) out.push(inline(from, to, `${base} lh-prop-cut-text`, id));
      else
        for (const r of nodeRanges(doc, from, to))
          out.push({
            kind: 'node',
            from: r.from,
            to: r.to,
            attrs: { class: `${base} lh-prop-cut-block`, 'data-ann-id': id },
            spec: { annotationId: id },
          });
      break;
    }
    case 'split': {
      if (p.pos === null || !preview) break;
      out.push(widget(p.pos, id, 'lh-prop-split-mark lh-prop-preview', '¶ new paragraph', -1));
      break;
    }
    case 'merge': {
      if (p.joinPos === null || !p.range || !preview) break;
      for (const r of nodeRanges(doc, p.range.from, p.range.to))
        out.push({
          kind: 'node',
          from: r.from,
          to: r.to,
          attrs: { class: `${base} lh-prop-merge-block`, 'data-ann-id': id },
          spec: { annotationId: id },
        });
      // End of the first paragraph's content: where the join happens.
      out.push(
        widget(
          p.joinPos - 1,
          id,
          'lh-prop-join-mark lh-prop-preview',
          '⤵ joins the next paragraph',
          1,
        ),
      );
      break;
    }
  }
  return out.filter((d): d is LayerDecoration => d !== null);
}

/**
 * Decorations for the cards of one document. `doc` is the folded document at the
 * version the card ranges are in (used for block-level proposal previews).
 */
export function annotationDecorations(
  cards: readonly Card[],
  ui: DecorationUi,
  doc: PMNode | null,
): LayerDecoration[] {
  const out: Array<LayerDecoration | null> = [];
  for (const card of cards) {
    if (card.phase === 'resolved' && card.id !== ui.activeId) continue;
    const active = card.id === ui.activeId;
    const preview = active || card.id === ui.hoverId;
    const stale = card.phase === 'stale' ? ' lh-ann-stale' : '';
    const act = active ? ' lh-ann-active' : '';
    if (card.kind === 'proposal') {
      if (card.phase !== 'open') continue;
      out.push(...proposalDecorations(card, doc, preview, active));
      continue;
    }
    const r = card.range;
    if (!r) continue;
    switch (card.kind) {
      case 'suggestion': {
        const s = card.data;
        if (s.kind === 'insertion') {
          if (active) out.push(widget(r.from, card.id, 'lh-ann-point lh-ann-active', '', -1));
          break;
        }
        out.push(
          inline(
            r.from,
            r.to,
            `lh-ann-mark lh-ann-suggestion lh-ann-${s.kind}${stale}${act}`,
            card.id,
            {
              'aria-describedby': ghostDescriptionId(card.id),
            },
          ),
        );
        break;
      }
      case 'comment':
        out.push(
          inline(
            r.from,
            r.to,
            `lh-ann-mark lh-ann-comment lh-ann-severity-${card.data.severity}${stale}${act}`,
            card.id,
            {
              'aria-describedby': ghostDescriptionId(card.id),
            },
          ),
        );
        break;
      case 'question':
        out.push(
          inline(r.from, r.to, `lh-ann-mark lh-ann-question${stale}${act}`, card.id, {
            'aria-describedby': ghostDescriptionId(card.id),
          }),
        );
        break;
      case 'citation-flag':
        if (card.data.status === 'cited') break;
        out.push(
          inline(r.from, r.to, `lh-ann-mark lh-ann-flag${stale}${act}`, card.id, {
            'aria-describedby': ghostDescriptionId(card.id),
          }),
        );
        break;
      case 'surfaced-source':
      case 'source-suggestion':
        out.push(
          inline(r.from, r.to, `lh-ann-mark lh-ann-source${stale}${act}`, card.id, {
            'aria-describedby': ghostDescriptionId(card.id),
          }),
        );
        break;
    }
  }
  return out.filter((d): d is LayerDecoration => d !== null);
}
