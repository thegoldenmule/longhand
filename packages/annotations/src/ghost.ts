/**
 * Ghost text: AI wording drawn as decoration only.
 *
 * Ghost text is never document text. In the editor it is a widget decoration; on
 * cards it is a span outside any editable. Either way it is:
 * - marked `data-lh-ghost`, `aria-hidden="true"` and `contenteditable="false"`;
 * - unselectable (`user-select: none` in styles.css, set inline too);
 * - stripped from the clipboard by {@link installGhostClipboardGuard}, whatever
 *   the selection covers.
 *
 * Screen readers get the wording from an accessible description elsewhere (see
 * `ghostDescriptionId`), which lives in a `hidden` element and so cannot be
 * selected or copied either.
 */

/** Attribute that marks ghost content. */
export const GHOST_ATTR = 'data-lh-ghost';

/** Id of the hidden element that describes an annotation's ghost text to assistive tech. */
export function ghostDescriptionId(annotationId: string): string {
  return `lh-ann-desc-${annotationId.replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

/** Creates a ghost text element. */
export function createGhostElement(
  doc: Document,
  text: string,
  opts: { className?: string; annotationId?: string } = {},
): HTMLElement {
  const el = doc.createElement('span');
  el.className = `lh-ghost${opts.className ? ` ${opts.className}` : ''}`;
  el.setAttribute(GHOST_ATTR, '');
  el.setAttribute('aria-hidden', 'true');
  el.setAttribute('contenteditable', 'false');
  el.setAttribute('draggable', 'false');
  el.style.userSelect = 'none';
  el.style.setProperty('-webkit-user-select', 'none');
  if (opts.annotationId) el.dataset.annId = opts.annotationId;
  el.textContent = text;
  return el;
}

const BLOCK_TAGS = new Set([
  'P',
  'DIV',
  'LI',
  'BLOCKQUOTE',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'UL',
  'OL',
  'SECTION',
  'ARTICLE',
  'HEADER',
  'FOOTER',
  'ASIDE',
  'PRE',
  'TR',
]);

/** Plain text of a fragment: text nodes, `<br>` as newline, a newline between blocks. */
export function fragmentText(root: Node): string {
  let out = '';
  const walk = (n: Node): void => {
    if (n.nodeType === 3) {
      out += n.nodeValue ?? '';
      return;
    }
    if (n.nodeType !== 1 && n.nodeType !== 11) return;
    const el = n as Element;
    if (n.nodeType === 1 && el.tagName === 'BR') {
      out += '\n';
      return;
    }
    const block = n.nodeType === 1 && BLOCK_TAGS.has(el.tagName);
    if (block && out && !out.endsWith('\n')) out += '\n';
    for (const c of Array.from(n.childNodes)) walk(c);
    if (block && out && !out.endsWith('\n')) out += '\n';
  };
  walk(root);
  return out.replace(/\n+$/, '');
}

/** Removes every ghost element (and hidden ghost descriptions) from a fragment, in place. */
export function stripGhosts(root: DocumentFragment | Element): number {
  const ghosts = root.querySelectorAll(`[${GHOST_ATTR}], [data-lh-ghost-desc]`);
  ghosts.forEach((g) => g.remove());
  return ghosts.length;
}

/** HTML with every ghost element removed. */
export function scrubGhostHtml(doc: Document, html: string): string {
  const tpl = doc.createElement('template');
  tpl.innerHTML = html;
  stripGhosts(tpl.content);
  const box = doc.createElement('div');
  box.appendChild(tpl.content);
  return box.innerHTML;
}

function selectionTouchesGhost(sel: Selection): boolean {
  for (let i = 0; i < sel.rangeCount; i++) {
    const r = sel.getRangeAt(i);
    const frag = r.cloneContents();
    if (frag.querySelector(`[${GHOST_ATTR}]`)) return true;
    // A selection inside a ghost element clones only its text: check the ancestors.
    let n: Node | null = r.commonAncestorContainer;
    while (n) {
      if (n.nodeType === 1 && (n as Element).hasAttribute(GHOST_ATTR)) return true;
      n = n.parentNode;
    }
  }
  return false;
}

/**
 * Installs a document-level copy/cut handler that keeps ghost text off the
 * clipboard. Returns the uninstaller.
 *
 * - If something already wrote the clipboard (the editor serializes its own
 *   document slice, which never contains widgets), ghost markup is scrubbed from
 *   the HTML it wrote, defensively.
 * - Otherwise, if the native selection touches ghost text (a card, or a mixed
 *   selection), the handler writes the selection without the ghost content.
 */
export function installGhostClipboardGuard(doc: Document = document): () => void {
  const onClipboard = (e: Event): void => {
    const ev = e as ClipboardEvent;
    const data = ev.clipboardData;
    if (!data) return;
    if (ev.defaultPrevented) {
      const html = data.getData('text/html');
      if (html && html.includes(GHOST_ATTR)) {
        const clean = scrubGhostHtml(doc, html);
        data.setData('text/html', clean);
        const tpl = doc.createElement('template');
        tpl.innerHTML = clean;
        data.setData('text/plain', fragmentText(tpl.content));
      }
      return;
    }
    const sel = doc.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
    if (!selectionTouchesGhost(sel)) return;
    const box = doc.createElement('div');
    for (let i = 0; i < sel.rangeCount; i++) {
      const r = sel.getRangeAt(i);
      // Inside a ghost element: nothing to copy.
      let n: Node | null = r.commonAncestorContainer;
      let inGhost = false;
      while (n) {
        if (n.nodeType === 1 && (n as Element).hasAttribute(GHOST_ATTR)) inGhost = true;
        n = n.parentNode;
      }
      if (inGhost) continue;
      box.appendChild(r.cloneContents());
    }
    stripGhosts(box);
    ev.preventDefault();
    data.setData('text/plain', fragmentText(box));
    data.setData('text/html', box.innerHTML);
  };
  doc.addEventListener('copy', onClipboard);
  doc.addEventListener('cut', onClipboard);
  return () => {
    doc.removeEventListener('copy', onClipboard);
    doc.removeEventListener('cut', onClipboard);
  };
}
