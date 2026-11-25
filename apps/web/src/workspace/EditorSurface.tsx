'use client';
/**
 * The writing page: `<LonghandEditor>` and the annotation margin in one
 * scrolling container (typewriter scrolling holds the caret line in it).
 */
import type { HttpCommitTransport } from '@longhand/client';
import {
  LonghandEditor,
  type EditorHandle,
  type EditorSettings,
  type SyncStatus,
  type WordCounts,
} from '@longhand/editor';
import { AnnotationMargin, type AnnotationsController } from '@longhand/annotations';
import type { DocumentState } from '@longhand/schema';
import type { Plugin } from 'prosemirror-state';
import { useRef } from 'react';
import { deviceId, editorSessionId } from '../lib/ids';

export interface EditorSurfaceProps {
  projectId: string;
  actorId: string;
  document: DocumentState;
  transport: HttpCommitTransport;
  settings: EditorSettings;
  plugins: readonly Plugin[];
  controller: AnnotationsController;
  showMargin: boolean;
  onReady: (h: EditorHandle) => void;
  onStatus: (s: SyncStatus) => void;
  onWordCount: (c: WordCounts) => void;
  hidden?: boolean;
}

/** True when the writer is typing in another field, which opening a document must not steal from. */
function typingElsewhere(): boolean {
  const el = globalThis.document.activeElement as HTMLElement | null;
  if (!el || el === globalThis.document.body) return false;
  return el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
}

/** Puts the caret in a newly opened document, unless the writer is typing somewhere else. */
function focusOnOpen(h: EditorHandle): void {
  requestAnimationFrame(() => {
    if (!h.view.dom.isConnected || h.view.dom.closest('[hidden]')) return;
    if (typingElsewhere()) return;
    h.focus();
  });
}

export function EditorSurface(props: EditorSurfaceProps) {
  const scroller = useRef<HTMLDivElement | null>(null);
  const { document: doc } = props;
  return (
    <div className="ws-scroll" ref={scroller} hidden={props.hidden} data-testid="writing-scroll">
      <div className={`ws-page${props.showMargin ? ' has-margin' : ''}`}>
        {
          <LonghandEditor
            key={doc.id}
            className="ws-editor"
            projectId={props.projectId}
            documentId={doc.id}
            actorId={props.actorId}
            doc={doc.content}
            version={doc.version}
            transport={props.transport}
            deviceId={deviceId()}
            sessionId={editorSessionId()}
            settings={props.settings}
            scrollContainer={() => scroller.current}
            extraPlugins={props.plugins}
            attributes={{
              'aria-label': `Manuscript: ${doc.title}`,
              'data-testid': 'manuscript',
              spellcheck: 'true',
            }}
            onReady={(h) => {
              props.onReady(h);
              focusOnOpen(h);
            }}
            onStatus={props.onStatus}
            onWordCount={props.onWordCount}
          />
        }
        <div className="ws-margin" aria-hidden={!props.showMargin}>
          <AnnotationMargin controller={props.controller} className="ws-margin-inner" />
        </div>
      </div>
    </div>
  );
}
