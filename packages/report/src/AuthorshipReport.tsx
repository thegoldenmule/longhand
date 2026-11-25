/**
 * `<AuthorshipReport>`: a calm, printable page for an authorship report.
 *
 * It prints what the report says and computes nothing new: the shares come from
 * the same `wordShares` the disclosure uses, and the proves table is printed
 * verbatim. Import the styles once: `import '@longhand/report/styles.css'`.
 */
import {
  PROVENANCE_CLASS_INFO,
  type AuthorshipReport,
  type ProvenanceClass,
} from '@longhand/schema';
import { useEffect, useState, type ReactNode } from 'react';
import { wordShares } from './disclosure';
import { formatDuration, formatInt, formatUtc } from './format';
import type { Report, ReportAiSession, ReportExtensions } from './types';

/** Props for {@link AuthorshipReport}. */
export interface AuthorshipReportProps {
  /** The report (from `computeReport`, or a bundle's report once verified). */
  report: AuthorshipReport;
  /** Page title; defaults to the project title, or the document's title for a document report. */
  title?: string;
  /** Extra content under the header, e.g. a verification badge. */
  children?: ReactNode;
  /** Copies text to the clipboard (defaults to `navigator.clipboard.writeText`). */
  copyText?: (text: string) => Promise<void>;
}

/** Short names for the chart and tables (the schema's labels, shortened where they wrap). */
const CLASS_LABEL: Record<ProvenanceClass, string> = {
  typed: 'Typed',
  'typed-from-suggestion': 'Typed from a suggestion',
  quoted: 'Quoted from a source',
  imported: 'Imported (unverified)',
  'pasted-external': 'Pasted (external)',
  'pasted-internal': PROVENANCE_CLASS_INFO['pasted-internal'].label,
};

const SUGGESTION_KIND_LABEL = {
  'word-choice': 'Word choice',
  insertion: 'Insert a sentence',
  rephrase: 'Rephrase hint',
} as const;

const PROPOSAL_KIND_LABEL = { move: 'Move', cut: 'Cut', split: 'Split', merge: 'Merge' } as const;

/** The lane's extra fields, read defensively: a report from elsewhere may lack them. */
function extras(report: AuthorshipReport): Partial<ReportExtensions> {
  const e = report.extensions;
  return e && typeof e === 'object' ? (e as Partial<ReportExtensions>) : {};
}

function aiSessions(report: AuthorshipReport): ReportAiSession[] {
  const s = (report.ai as Partial<Report['ai']>).sessions;
  return Array.isArray(s) ? s : [];
}

function shortHash(hash: string): string {
  return `${hash.slice(0, 12)}…`;
}

function Section(props: { id: string; title: string; children: ReactNode; note?: ReactNode }) {
  return (
    <section className="lh-report-section" aria-labelledby={`lh-report-${props.id}`}>
      <h2 id={`lh-report-${props.id}`}>{props.title}</h2>
      {props.note ? <p className="lh-report-note">{props.note}</p> : null}
      {props.children}
    </section>
  );
}

function Stat(props: { label: string; value: string; detail?: string }) {
  return (
    <div className="lh-report-stat">
      <dt>{props.label}</dt>
      <dd>
        <span className="lh-report-stat-value">{props.value}</span>
        {props.detail ? <span className="lh-report-stat-detail">{props.detail}</span> : null}
      </dd>
    </div>
  );
}

async function defaultCopy(text: string): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  // Fallback for pages without the async clipboard (e.g. file:// or old browsers).
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  const ok = document.execCommand('copy');
  area.remove();
  if (!ok) throw new Error('copy failed');
}

function Disclosure(props: { text: string; copyText: (text: string) => Promise<void> }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copy = () => {
    props.copyText(props.text).then(
      () => setState('copied'),
      () => setState('failed'),
    );
  };
  return (
    <section className="lh-report-disclosure" aria-labelledby="lh-report-disclosure">
      <div className="lh-report-disclosure-head">
        <h2 id="lh-report-disclosure">Disclosure statement</h2>
        <button type="button" className="lh-report-copy" onClick={copy}>
          {state === 'copied' ? 'Copied' : 'Copy'}
        </button>
      </div>
      <p className="lh-report-disclosure-text">{props.text}</p>
      <p className="lh-report-note" aria-live="polite">
        {state === 'failed'
          ? 'Could not copy. Select the statement and copy it by hand.'
          : 'Generated from the ledger by a fixed template, not written by AI.'}
      </p>
    </section>
  );
}

/** Words by class: one segmented bar (the whole manuscript) and its table. */
function WordsChart({ report }: { report: AuthorshipReport }) {
  const shares = wordShares(report.words);
  if (report.words.total === 0) return <p className="lh-report-empty">No words yet.</p>;
  return (
    <figure className="lh-report-figure">
      <div
        className="lh-report-bar"
        role="img"
        aria-label={`Words by origin: ${shares.map((s) => `${CLASS_LABEL[s.class]} ${s.label}`).join(', ')}`}
      >
        {shares.map((s) => (
          <div
            key={s.class}
            className="lh-report-bar-part"
            data-class={s.class}
            style={{ flexGrow: s.words }}
            title={`${CLASS_LABEL[s.class]}: ${formatInt(s.words)} words (${s.label})`}
          >
            {/* Labels only fit in wide parts; the table below has every value. */}
            {s.tenths >= 120 ? <span>{s.label}</span> : null}
          </div>
        ))}
      </div>
      <table className="lh-report-table lh-report-legend">
        <thead>
          <tr>
            <th scope="col">Origin</th>
            <th scope="col" className="lh-num">
              Words
            </th>
            <th scope="col" className="lh-num">
              Share
            </th>
            <th scope="col" className="lh-num">
              Characters
            </th>
          </tr>
        </thead>
        <tbody>
          {shares.map((s) => (
            <tr key={s.class}>
              <th scope="row">
                <span className="lh-report-swatch" data-class={s.class} aria-hidden="true" />
                {CLASS_LABEL[s.class]}
              </th>
              <td className="lh-num">{formatInt(s.words)}</td>
              <td className="lh-num">{s.label}</td>
              <td className="lh-num">{formatInt(report.characters.byClass[s.class])}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">Total</th>
            <td className="lh-num">{formatInt(report.words.total)}</td>
            <td className="lh-num">100%</td>
            <td className="lh-num">{formatInt(report.characters.total)}</td>
          </tr>
        </tfoot>
      </table>
    </figure>
  );
}

/** Writing sessions on a time axis from the first to the last, then as a table. */
function Sessions({ report }: { report: AuthorshipReport }) {
  const list = report.sessions.list;
  const [open, setOpen] = useState(list.length <= 12);
  // A closed <details> does not print, so open it for printing.
  useEffect(() => {
    const onPrint = () => setOpen(true);
    window.addEventListener('beforeprint', onPrint);
    return () => window.removeEventListener('beforeprint', onPrint);
  }, []);
  if (list.length === 0)
    return <p className="lh-report-empty">No writing sessions were recorded in Longhand.</p>;
  const start = Date.parse(list[0]!.startTime);
  const end = Math.max(...list.map((s) => Date.parse(s.endTime)));
  const span = Math.max(end - start, 1);
  return (
    <>
      <div
        className="lh-report-timeline"
        role="img"
        aria-label={`${list.length} writing sessions from ${formatUtc(list[0]!.startTime)} to ${formatUtc(new Date(end).toISOString())}`}
      >
        <div className="lh-report-timeline-track">
          {list.map((s, i) => {
            const left = ((Date.parse(s.startTime) - start) / span) * 100;
            const width = ((Date.parse(s.endTime) - Date.parse(s.startTime)) / span) * 100;
            return (
              <div
                key={i}
                className="lh-report-timeline-mark"
                style={{ left: `${Math.min(left, 99.5)}%`, width: `max(4px, ${width}%)` }}
                title={`Session ${i + 1}: ${formatUtc(s.startTime)}, ${formatDuration(s.activeMs)} active`}
              />
            );
          })}
        </div>
        <div className="lh-report-timeline-axis" aria-hidden="true">
          <span>{formatUtc(list[0]!.startTime)}</span>
          {list.length > 1 ? <span>{formatUtc(new Date(end).toISOString())}</span> : null}
        </div>
      </div>
      <details
        className="lh-report-details"
        open={open}
        onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
      >
        <summary>All {formatInt(list.length)} sessions</summary>
        <table className="lh-report-table">
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">Started</th>
              <th scope="col">Ended</th>
              <th scope="col" className="lh-num">
                Active
              </th>
              <th scope="col" className="lh-num">
                Characters typed or inserted
              </th>
            </tr>
          </thead>
          <tbody>
            {list.map((s, i) => (
              <tr key={i}>
                <td>{i + 1}</td>
                <td>{formatUtc(s.startTime)}</td>
                <td>{formatUtc(s.endTime)}</td>
                <td className="lh-num">{formatDuration(s.activeMs)}</td>
                <td className="lh-num">{formatInt(s.charactersInserted)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </>
  );
}

function AiActivity({ report }: { report: AuthorshipReport }) {
  const sessions = aiSessions(report);
  const { ai, suggestions, proposals } = report;
  const byKind = extras(report).suggestions?.byKind;
  const none = ai.feedbackRequests + sessions.length + suggestions.total + proposals.total === 0;
  if (none) return <p className="lh-report-empty">No AI feedback was requested in Longhand.</p>;
  return (
    <>
      <dl className="lh-report-stats lh-report-stats-small">
        <Stat label="Feedback requests" value={formatInt(ai.feedbackRequests)} />
        <Stat label="Comments" value={formatInt(ai.comments)} />
        <Stat label="Questions" value={formatInt(ai.questions)} />
        <Stat label="Citation flags" value={formatInt(ai.citationFlags)} />
        <Stat label="Discuss threads" value={formatInt(ai.discussThreads)} />
      </dl>
      {sessions.length > 0 ? (
        <table className="lh-report-table">
          <caption>AI sessions</caption>
          <thead>
            <tr>
              <th scope="col">Started</th>
              <th scope="col">Kind</th>
              <th scope="col">Model</th>
              <th scope="col">Prompt version</th>
              <th scope="col">Outcome</th>
              <th scope="col" className="lh-num">
                Annotations
              </th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((s) => (
              <tr key={s.id}>
                <td>{formatUtc(s.startedAt)}</td>
                <td>
                  {s.kind === 'review' ? `Review (${s.scope ?? 'project'})` : 'Discuss reply'}
                  {s.intensity ? `, ${s.intensity}` : ''}
                </td>
                <td>
                  <code>{s.model}</code>
                </td>
                <td>
                  {s.systemPromptVersion ? <code>{s.systemPromptVersion}</code> : 'not recorded'}
                </td>
                <td>{s.status}</td>
                <td className="lh-num">{formatInt(s.annotations)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {suggestions.total > 0 ? (
        <table className="lh-report-table">
          <caption>Wording suggestions by outcome</caption>
          <thead>
            <tr>
              <th scope="col">Kind</th>
              {(['adopted', 'adapted', 'dismissed', 'stale', 'open'] as const).map((o) => (
                <th key={o} scope="col" className="lh-num">
                  {o === 'open' ? 'Still open' : o[0]!.toUpperCase() + o.slice(1)}
                </th>
              ))}
              <th scope="col" className="lh-num">
                Total
              </th>
            </tr>
          </thead>
          <tbody>
            {(['word-choice', 'insertion', 'rephrase'] as const).map((k) =>
              suggestions.byKind[k] > 0 ? (
                <tr key={k}>
                  <th scope="row">{SUGGESTION_KIND_LABEL[k]}</th>
                  {(['adopted', 'adapted', 'dismissed', 'stale', 'open'] as const).map((o) => (
                    <td key={o} className="lh-num">
                      {byKind ? formatInt(byKind[k][o]) : '–'}
                    </td>
                  ))}
                  <td className="lh-num">{formatInt(suggestions.byKind[k])}</td>
                </tr>
              ) : null,
            )}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">All</th>
              {(['adopted', 'adapted', 'dismissed', 'stale', 'open'] as const).map((o) => (
                <td key={o} className="lh-num">
                  {formatInt(suggestions.byOutcome[o])}
                </td>
              ))}
              <td className="lh-num">{formatInt(suggestions.total)}</td>
            </tr>
          </tfoot>
        </table>
      ) : null}
      {proposals.total > 0 ? (
        <table className="lh-report-table">
          <caption>Structural proposals</caption>
          <thead>
            <tr>
              <th scope="col">Kind</th>
              {(['proposed', 'accepted', 'rejected', 'stale', 'open'] as const).map((o) => (
                <th key={o} scope="col" className="lh-num">
                  {o === 'open' ? 'Still open' : o[0]!.toUpperCase() + o.slice(1)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(['move', 'cut', 'split', 'merge'] as const).map((k) =>
              proposals.byKind[k].proposed > 0 ? (
                <tr key={k}>
                  <th scope="row">{PROPOSAL_KIND_LABEL[k]}</th>
                  {(['proposed', 'accepted', 'rejected', 'stale', 'open'] as const).map((o) => (
                    <td key={o} className="lh-num">
                      {formatInt(proposals.byKind[k][o])}
                    </td>
                  ))}
                </tr>
              ) : null,
            )}
          </tbody>
        </table>
      ) : null}
    </>
  );
}

function Pastes({ report }: { report: AuthorshipReport }) {
  const events = report.pastes.events;
  if (events.length === 0) return <p className="lh-report-empty">No pastes.</p>;
  return (
    <table className="lh-report-table">
      <thead>
        <tr>
          <th scope="col">When</th>
          <th scope="col">From</th>
          <th scope="col">Document</th>
          <th scope="col" className="lh-num">
            Words
          </th>
          <th scope="col" className="lh-num">
            Characters
          </th>
        </tr>
      </thead>
      <tbody>
        {events.map((p) => (
          <tr key={p.seq}>
            <td>{formatUtc(p.time)}</td>
            <td>
              {p.origin === 'external'
                ? 'Outside the editor'
                : p.verifiedInternal === false
                  ? 'This project (not verified, counted as pasted)'
                  : 'This project'}
              {p.via === 'drop' ? ', dropped' : ''}
            </td>
            <td>
              <code>{p.documentId}</code>
            </td>
            <td className="lh-num">{formatInt(p.words)}</td>
            <td className="lh-num">{formatInt(p.characters)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Unwitnessed({ report }: { report: AuthorshipReport }) {
  const threshold = extras(report).unwitnessedThresholdMs ?? 60_000;
  if (report.unwitnessed.length === 0)
    return (
      <p className="lh-report-empty">
        None. Every commit by the writer reached the server within{' '}
        {formatDuration(threshold).replace(/^1 min$/, '1 minute')} of being written.
      </p>
    );
  return (
    <table className="lh-report-table lh-report-unwitnessed">
      <thead>
        <tr>
          <th scope="col">Commits</th>
          <th scope="col">Written (device clock)</th>
          <th scope="col">Reached the server</th>
          <th scope="col">Why</th>
        </tr>
      </thead>
      <tbody>
        {report.unwitnessed.map((u, i) => (
          <tr key={i}>
            <td>{u.fromSeq === u.toSeq ? `#${u.fromSeq}` : `#${u.fromSeq}–#${u.toSeq}`}</td>
            <td>
              {formatUtc(u.firstClientTime)}
              {u.lastClientTime !== u.firstClientTime ? ` to ${formatUtc(u.lastClientTime)}` : ''}
            </td>
            <td>{formatUtc(u.serverTime)}</td>
            <td>
              {u.reason === 'not-witnessed'
                ? 'No server witness'
                : 'Queued offline; the server could not vouch for when it was written'}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ProvesTable({ report }: { report: AuthorshipReport }) {
  const { proves, doesNotProve } = report.provesTable;
  const rows = Math.max(proves.length, doesNotProve.length);
  return (
    <table className="lh-report-table lh-report-proves">
      <thead>
        <tr>
          <th scope="col">Proves</th>
          <th scope="col">Does not prove</th>
        </tr>
      </thead>
      <tbody>
        {Array.from({ length: rows }, (_, i) => (
          <tr key={i}>
            <td>{proves[i] ?? ''}</td>
            <td>{doesNotProve[i] ?? ''}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The authorship report page. */
export function AuthorshipReport(props: AuthorshipReportProps) {
  const { report } = props;
  const ext = extras(report);
  const scopeDoc =
    report.scope.kind === 'document'
      ? ext.documents?.find((d) => d.id === (report.scope as { documentId: string }).documentId)
      : undefined;
  const title =
    props.title ?? (scopeDoc ? scopeDoc.title : (ext.projectTitle ?? 'Authorship report'));
  const typed = wordShares(report.words).find((s) => s.class === 'typed');
  const imports = ext.imports ?? [];
  return (
    <article className="lh-report">
      <header className="lh-report-header">
        <p className="lh-report-eyebrow">Authorship report</p>
        <h1>{title}</h1>
        <p className="lh-report-meta">
          {report.scope.kind === 'document' ? 'One document' : 'The whole project'} · commits 1–
          {formatInt(report.throughSeq)} · head <code>{shortHash(report.headHash)}</code>
        </p>
        {props.children}
      </header>

      <Disclosure text={report.disclosure} copyText={props.copyText ?? defaultCopy} />

      <dl className="lh-report-stats">
        <Stat label="Words" value={formatInt(report.words.total)} />
        <Stat
          label="Typed directly"
          value={report.words.total === 0 ? '–' : (typed?.label ?? '0%')}
        />
        <Stat
          label="Writing sessions"
          value={formatInt(report.sessions.count)}
          detail={
            report.sessions.days > 0
              ? `on ${formatInt(report.sessions.days)} ${report.sessions.days === 1 ? 'day' : 'days'}`
              : undefined
          }
        />
        <Stat label="Active writing" value={formatDuration(report.activeWritingMs)} />
        <Stat label="AI sessions" value={formatInt(aiSessions(report).length)} />
      </dl>

      <Section
        id="words"
        title="Words by origin"
        note="A word made of characters from more than one origin counts as the least trusted of them."
      >
        <WordsChart report={report} />
      </Section>

      <Section
        id="sessions"
        title="Writing sessions"
        note="Times are UTC, from the writer's device."
      >
        <Sessions report={report} />
      </Section>

      <Section
        id="ai"
        title="AI activity"
        note="Longhand’s AI writes only in the margin, never in the text."
      >
        <AiActivity report={report} />
      </Section>

      <Section id="pastes" title="Pastes">
        <Pastes report={report} />
      </Section>

      {imports.length > 0 || report.imports.documents > 0 ? (
        <Section
          id="imports"
          title="Imports"
          note="Imported text is labeled unverified: the record cannot say who wrote it."
        >
          <table className="lh-report-table">
            <thead>
              <tr>
                <th scope="col">Document</th>
                <th scope="col">Format</th>
                <th scope="col">File</th>
                <th scope="col" className="lh-num">
                  Words at import
                </th>
              </tr>
            </thead>
            <tbody>
              {imports.map((i) => (
                <tr key={i.seq}>
                  <td>{i.title}</td>
                  <td>{i.sourceFormat}</td>
                  <td>{i.sourceName ?? '–'}</td>
                  <td className="lh-num">{formatInt(i.words)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      ) : null}

      <Section
        id="unwitnessed"
        title="Unwitnessed intervals"
        note="Writing queued while the connection was down is witnessed only when it reaches the server, so its timing rests on the device's clock."
      >
        <Unwitnessed report={report} />
      </Section>

      <Section id="proves" title="What this record proves, and what it doesn't">
        <ProvesTable report={report} />
      </Section>
    </article>
  );
}
