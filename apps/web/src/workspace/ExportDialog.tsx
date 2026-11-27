'use client';
/**
 * Export (F9): Markdown, DOCX or PDF through the ledger service's export route,
 * with an optional provenance appendix computed here by `@longhand/report`.
 * A one-document project exports the project, with no "What" to choose.
 */
import type { ExportFormat, LonghandClient } from '@longhand/client';
import { computeReport, provenanceSummaryForExport } from '@longhand/report';
import type { Commit } from '@longhand/schema';
import { useEffect, useRef, useState } from 'react';
import { saveBytes } from '../lib/download';

const FORMATS: Array<{ id: ExportFormat; label: string; hint: string }> = [
  { id: 'md', label: 'Markdown', hint: '.md, with footnotes' },
  { id: 'docx', label: 'Word', hint: '.docx, real footnotes' },
  { id: 'pdf', label: 'PDF', hint: 'typeset, EB Garamond' },
];

export function ExportDialog(props: {
  client: LonghandClient;
  projectId: string;
  commits: readonly Commit[];
  headHash: string;
  documentId: string | null;
  /** The manuscript is one document: no scope choice, project scope. */
  single: boolean;
  onClose: () => void;
}) {
  const [format, setFormat] = useState<ExportFormat>('docx');
  const [scope, setScope] = useState<'project' | 'document'>('project');
  const [appendix, setAppendix] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDialogElement | null>(null);

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const docScoped = !props.single && scope === 'document' && props.documentId;
      let provenance = null;
      if (appendix && props.commits.length) {
        const report = computeReport(props.commits, {
          scope: docScoped ? { documentId: props.documentId as string } : 'project',
        });
        provenance = provenanceSummaryForExport(
          report,
          `Ledger head ${props.headHash.slice(0, 16)}… at seq ${props.commits.length}. Download the verification bundle from the authorship report and check it at /verify.`,
        );
      }
      const file = await props.client.exportProject(props.projectId, {
        format,
        ...(docScoped ? { documentIds: [props.documentId as string] } : {}),
        provenance,
      });
      saveBytes(file.bytes, file.filename, file.mimeType);
      props.onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog
      ref={ref}
      className="ws-dialog"
      aria-labelledby="export-title"
      data-testid="export-dialog"
      onClose={props.onClose}
      onCancel={props.onClose}
    >
      <form
        method="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <h2 id="export-title">Export</h2>
        <fieldset className="ws-choices">
          <legend>Format</legend>
          {FORMATS.map((f) => (
            <label key={f.id} className="ws-choice">
              <input
                type="radio"
                name="format"
                value={f.id}
                checked={format === f.id}
                onChange={() => setFormat(f.id)}
              />
              <span>
                {f.label} <span className="ws-muted">{f.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
        {!props.single && (
          <fieldset className="ws-choices">
            <legend>What</legend>
            <label className="ws-choice">
              <input
                type="radio"
                name="scope"
                checked={scope === 'project'}
                onChange={() => setScope('project')}
              />
              The whole manuscript
            </label>
            <label className="ws-choice">
              <input
                type="radio"
                name="scope"
                disabled={!props.documentId}
                checked={scope === 'document'}
                onChange={() => setScope('document')}
              />
              This document only
            </label>
          </fieldset>
        )}
        <label className="ws-choice">
          <input
            type="checkbox"
            name="appendix"
            checked={appendix}
            onChange={(e) => setAppendix(e.target.checked)}
          />
          Add a provenance appendix (words by origin, the disclosure and what the record proves)
        </label>
        {error && (
          <p className="lh-error" role="alert">
            {error}
          </p>
        )}
        <div className="lh-form-actions">
          <button type="button" className="lh-button lh-button-quiet" onClick={props.onClose}>
            Cancel
          </button>
          <button type="submit" className="lh-button lh-button-primary" disabled={busy}>
            {busy ? 'Exporting…' : 'Export'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
