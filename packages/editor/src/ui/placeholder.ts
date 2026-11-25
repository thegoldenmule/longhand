/**
 * Placeholder: a faint hint ("Begin here.") in an empty document, so a new page
 * shows where to write.
 *
 * It is a widget decoration, never document text: it is `aria-hidden`,
 * `contenteditable="false"`, not selectable, and absolutely positioned so the
 * caret sits at the start of the line. It shows only while the whole document is
 * one empty paragraph, so it is gone on the first keystroke, and CSS hides it
 * when the editor is read-only.
 */
import type { Node as PMNode } from 'prosemirror-model';
import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';

/** Default placeholder text. */
export const DEFAULT_PLACEHOLDER = 'Begin here.';

/** Plugin key. */
export const placeholderKey = new PluginKey('longhand-placeholder');

/** True when the document is a single empty paragraph (a new document). */
export function isEmptyDocument(doc: PMNode): boolean {
  const first = doc.firstChild;
  return (
    doc.childCount === 1 &&
    first !== null &&
    first.type.name === 'paragraph' &&
    first.content.size === 0
  );
}

/** The placeholder plugin. */
export function placeholderPlugin(text: string = DEFAULT_PLACEHOLDER): Plugin {
  return new Plugin({
    key: placeholderKey,
    props: {
      decorations(state) {
        if (!isEmptyDocument(state.doc)) return null;
        const widget = Decoration.widget(
          1,
          () => {
            const el = document.createElement('span');
            el.className = 'lh-placeholder';
            el.setAttribute('aria-hidden', 'true');
            el.setAttribute('contenteditable', 'false');
            el.textContent = text;
            return el;
          },
          { side: 1, ignoreSelection: true, key: `lh-placeholder:${text}` },
        );
        return DecorationSet.create(state.doc, [widget]);
      },
    },
  });
}
