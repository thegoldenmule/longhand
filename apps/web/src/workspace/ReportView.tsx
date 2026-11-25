'use client';
/**
 * The authorship report (F7) for the project or the open document, recomputed
 * from the ledger with the server's witnesses, and the verification bundle,
 * built client-side with `@longhand/report`'s `buildBundle` from `/bundle`.
 */
import type { BundleData, LonghandClient } from '@longhand/client';
import { AuthorshipReport, buildBundle, computeReport, type Report } from '@longhand/report';
import { useEffect, useMemo, useState } from 'react';
import { saveBytes } from '../lib/download';

export type ReportScope = 'project' | { documentId: string };

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'project'
  );
}

export async function downloadBundle(
  client: LonghandClient,
  projectId: string,
  title: string,
  scope: ReportScope,
): Promise<{ unwitnessed: number }> {
  const data = await client.bundle(projectId);
  const bundle = buildBundle({
    commits: data.commits,
    witnesses: data.witnesses,
    publicKeyPem: data.publicKeyPem,
    keyId: data.keyId,
    scope,
  });
  saveBytes(
    `${JSON.stringify(bundle, null, 2)}\n`,
    `${slug(title)}.longhand-bundle.json`,
    'application/json',
  );
  return { unwitnessed: data.unwitnessedSeqs.length };
}

export function ReportView(props: {
  client: LonghandClient;
  projectId: string;
  title: string;
  headSeq: number;
  documentId: string | null;
  documentTitle: string | null;
  onExport: () => void;
}) {
  const [scope, setScope] = useState<'project' | 'document'>('project');
  const [data, setData] = useState<BundleData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { client, projectId, headSeq } = props;

  useEffect(() => {
    let live = true;
    const t = setTimeout(
      () => {
        client
          .bundle(projectId)
          .then((d) => live && setData(d))
          .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
      },
      data ? 800 : 0,
    );
    return () => {
      live = false;
      clearTimeout(t);
    };
    // Refetch (debounced) as the ledger grows; `data` only picks the delay.
  }, [client, projectId, headSeq]);

  const reportScope: ReportScope =
    scope === 'document' && props.documentId ? { documentId: props.documentId } : 'project';
  const scopeKey = typeof reportScope === 'string' ? reportScope : reportScope.documentId;
  const computed = useMemo((): { report: Report | null; error: string | null } => {
    if (!data || data.commits.length === 0) return { report: null, error: null };
    try {
      const s: ReportScope = scopeKey === 'project' ? 'project' : { documentId: scopeKey };
      return {
        report: computeReport(data.commits, { scope: s, witnesses: data.witnesses }),
        error: null,
      };
    } catch (e) {
      return { report: null, error: e instanceof Error ? e.message : String(e) };
    }
  }, [data, scopeKey]);
  const report = computed.report;

  return (
    <div className="ws-view ws-report" data-testid="report-view">
      <div className="ws-view-toolbar">
        <div className="ws-view-actions">
          <div className="ws-seg ws-seg-small" role="group" aria-label="Report scope">
            <button
              type="button"
              aria-pressed={scope === 'project'}
              onClick={() => setScope('project')}
            >
              Whole project
            </button>
            <button
              type="button"
              aria-pressed={scope === 'document'}
              disabled={!props.documentId}
              onClick={() => setScope('document')}
            >
              {props.documentTitle ?? 'This document'}
            </button>
          </div>
          <button
            type="button"
            className="lh-button"
            data-testid="download-bundle"
            onClick={async () => {
              setNotice(null);
              try {
                const r = await downloadBundle(client, projectId, props.title, reportScope);
                setNotice(
                  r.unwitnessed
                    ? `${r.unwitnessed} recent changes were not witnessed yet; download again in a moment for a bundle that verifies.`
                    : 'Bundle downloaded. Anyone can check it at /verify, entirely in their browser.',
                );
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              }
            }}
          >
            Download verification bundle
          </button>
          <button type="button" className="lh-button lh-button-quiet" onClick={props.onExport}>
            Export…
          </button>
        </div>
      </div>
      {notice && (
        <p className="ws-notice" role="status">
          {notice}{' '}
          <a href="/verify" target="_blank" rel="noreferrer">
            Open the verifier
          </a>
        </p>
      )}
      {(error ?? computed.error) && (
        <p className="lh-error" role="alert">
          {error ?? computed.error}
        </p>
      )}
      {!report && !error && !computed.error && (
        <p className="ws-muted">Recomputing from the ledger…</p>
      )}
      {report && (
        <AuthorshipReport
          report={report}
          title={scope === 'document' && props.documentTitle ? props.documentTitle : props.title}
        />
      )}
    </div>
  );
}
