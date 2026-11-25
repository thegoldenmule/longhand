/**
 * The verifier web page: drop a bundle, see each check and the recomputed
 * report. Everything happens in this tab: the file is read with the File API and
 * checked with WebCrypto; nothing is sent anywhere.
 */
import { AuthorshipReport } from '@longhand/report';
import { useCallback, useRef, useState, type DragEvent } from 'react';
import { verifyBundle, type CheckStatus, type VerificationResult } from '../src/verify';

type State =
  | { kind: 'idle' }
  | { kind: 'checking'; name: string }
  | { kind: 'unreadable'; name: string; message: string }
  | { kind: 'done'; name: string; result: VerificationResult };

const STATUS_LABEL: Record<CheckStatus, string> = {
  pass: 'Passed',
  fail: 'Failed',
  skip: 'Not checked',
};

function Checks({ result }: { result: VerificationResult }) {
  return (
    <ol className="v-checks" aria-label="Checks">
      {result.checks.map((c) => (
        <li key={c.id} className="v-check" data-status={c.status} data-check={c.id}>
          <span className="v-pill" data-status={c.status}>
            {STATUS_LABEL[c.status]}
          </span>
          <div>
            <h3>{c.title}</h3>
            <p>{c.summary}</p>
            {c.details.length > 0 ? (
              <ul className="v-details">
                {c.details.map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
              </ul>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

function Verdict({ name, result }: { name: string; result: VerificationResult }) {
  const failed = result.checks.filter((c) => c.status === 'fail').map((c) => c.title);
  return (
    <div className="v-verdict" data-ok={result.ok} role="status">
      <p className="v-verdict-title">{result.ok ? 'Verified' : 'Not verified'}</p>
      <p className="v-verdict-text">
        {result.ok
          ? 'The ledger, its signatures and its report agree.'
          : `Failed: ${failed.join(', ')}. Do not rely on this bundle's report.`}
      </p>
      <p className="v-file">{name}</p>
    </div>
  );
}

export function App() {
  const [state, setState] = useState<State>({ kind: 'idle' });
  const [dragging, setDragging] = useState(false);
  const [keyId, setKeyId] = useState('');
  const input = useRef<HTMLInputElement>(null);

  const check = useCallback(
    async (file: File) => {
      setState({ kind: 'checking', name: file.name });
      let bundle: unknown;
      try {
        bundle = JSON.parse(await file.text());
      } catch (e) {
        setState({ kind: 'unreadable', name: file.name, message: (e as Error).message });
        return;
      }
      const expected = keyId.trim();
      const result = await verifyBundle(bundle, expected ? { expectedKeyId: expected } : {});
      setState({ kind: 'done', name: file.name, result });
    },
    [keyId],
  );

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) void check(file);
  };

  return (
    <div
      className="v-page"
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <header className="v-header">
        <p className="v-eyebrow">Longhand</p>
        <h1>Verify an authorship record</h1>
        <p className="v-lede">
          Drop a Longhand verification bundle to check its hash chain and server signatures, re-fold
          the ledger and recompute the report from scratch. Everything runs in this browser; the
          file is never uploaded.
        </p>
      </header>

      <div
        className="v-drop"
        data-dragging={dragging}
        data-testid="dropzone"
        onClick={() => input.current?.click()}
      >
        <p>
          <strong>Drop a bundle here</strong>
          <span> or </span>
          <button
            type="button"
            className="v-link"
            onClick={(e) => {
              e.stopPropagation();
              input.current?.click();
            }}
          >
            choose a file
          </button>
        </p>
        <p className="v-hint">A .json file exported from Longhand.</p>
        <input
          ref={input}
          type="file"
          accept=".json,application/json"
          hidden
          aria-label="Bundle file"
          onChange={(e) => {
            const file = e.currentTarget.files?.[0];
            if (file) void check(file);
            e.currentTarget.value = '';
          }}
        />
      </div>

      <details className="v-options">
        <summary>Expected witness key (optional)</summary>
        <label>
          <span>Key id published by Longhand</span>
          <input
            type="text"
            spellCheck={false}
            placeholder="64 hex characters"
            value={keyId}
            onChange={(e) => setKeyId(e.currentTarget.value)}
          />
        </label>
      </details>

      {state.kind === 'checking' ? (
        <p className="v-status" role="status">
          Checking {state.name}…
        </p>
      ) : null}
      {state.kind === 'unreadable' ? (
        <div className="v-verdict" data-ok="false" role="status">
          <p className="v-verdict-title">Not a bundle</p>
          <p className="v-verdict-text">
            {state.name} is not JSON ({state.message}).
          </p>
        </div>
      ) : null}
      {state.kind === 'done' ? (
        <main className="v-result">
          <Verdict name={state.name} result={state.result} />
          <Checks result={state.result} />
          {state.result.report ? (
            <div className="v-report">
              <p className="v-report-label">
                {state.result.ok
                  ? 'The report, recomputed from the ledger'
                  : 'The report as recomputed from the ledger (not the one in the bundle)'}
              </p>
              <AuthorshipReport report={state.result.report} />
            </div>
          ) : null}
        </main>
      ) : null}
    </div>
  );
}
