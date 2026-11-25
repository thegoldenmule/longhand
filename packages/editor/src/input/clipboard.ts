/**
 * The private clipboard marker that lets the editor tell an internal paste (copied
 * from this project) from an external one.
 *
 * On copy or cut the editor writes the usual `text/html` and `text/plain`, plus:
 * - a custom MIME type {@link MARKER_MIME} carrying the marker JSON, and
 * - the same JSON in a `data-longhand-slice` attribute on the first HTML element,
 *   which survives browsers that drop custom MIME types.
 *
 * A paste counts as internal only if the marker names this project and the SHA-256
 * of the inserted inline text equals the marker's `textHash`. Anything else is
 * external. The marker can only *claim* internal provenance; the fold still checks
 * the text against the `SliceCopied` snapshot and downgrades on mismatch.
 */
import { z } from 'zod';

/** Custom clipboard MIME type for the marker. */
export const MARKER_MIME = 'application/x-longhand-slice';
/** HTML attribute carrying the marker. */
export const MARKER_ATTR = 'data-longhand-slice';

/** What the marker says about the copied slice. */
export interface SliceMarker {
  v: 1;
  copyId: string;
  projectId: string;
  documentId: string;
  textHash: string;
}

const MarkerSchema = z.object({
  v: z.literal(1),
  copyId: z.string().min(1).max(64),
  projectId: z.string().min(1).max(64),
  documentId: z.string().min(1).max(64),
  textHash: z.string().regex(/^[0-9a-f]{64}$/),
});

/** Serializes a marker. */
export function encodeMarker(m: SliceMarker): string {
  return JSON.stringify(m);
}

/** Parses a marker, or null if it is missing or malformed. */
export function decodeMarker(raw: string | null | undefined): SliceMarker | null {
  if (!raw) return null;
  try {
    const parsed = MarkerSchema.safeParse(JSON.parse(raw));
    return parsed.success ? (parsed.data as SliceMarker) : null;
  } catch {
    return null;
  }
}

const ATTR_RE = new RegExp(`${MARKER_ATTR}="([^"]*)"`);

function unescapeAttr(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Reads a marker from clipboard data: the custom MIME type first, then the HTML attribute. */
export function readMarkerFromTransfer(dt: DataTransfer): SliceMarker | null {
  try {
    const marker = decodeMarker(dt.getData(MARKER_MIME));
    if (marker) return marker;
  } catch {
    // Fall through to the HTML attribute.
  }
  try {
    const html = dt.getData('text/html');
    const m = html ? ATTR_RE.exec(html) : null;
    return m ? decodeMarker(unescapeAttr(m[1] as string)) : null;
  } catch {
    return null;
  }
}

/** Adds the marker attribute to the first element of a serialized clipboard DOM. */
export function stampMarker(dom: HTMLElement, marker: SliceMarker): void {
  const first = dom.querySelector('[data-pm-slice]') ?? dom.firstElementChild;
  if (first) first.setAttribute(MARKER_ATTR, encodeMarker(marker));
}
