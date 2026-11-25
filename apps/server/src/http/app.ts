/**
 * HTTP routes (Hono). See README "API reference" for the full list.
 */
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import type { CommitDraft, PMNodeJSON, ProvenanceSummary } from '@longhand/schema';
import { bearerToken, type Authenticator, type Principal } from '../auth';
import type { SessionStreamEvent } from '../agent/sessions';
import { renderExport, type ExportRequest } from '../research/export';
import { BlockedUrlError, fetchPublicPage, type PageFetchOptions } from '../research/ssrf';
import type { LedgerService, SubmitOutcome } from '../service';
import { HttpError, InvariantViolation, errMsg } from '../util';
import { nodeToJSON } from '../ledger/history';
import { sse } from './sse';

type Env = { Variables: { principal: Principal } };

/** Options for {@link createApp}. */
export interface AppOptions {
  service: LedgerService;
  auth: Authenticator;
  /** Allowed browser origins (CORS). Default `http://localhost:3100`. */
  corsOrigins?: string[];
  pageFetch?: PageFetchOptions;
}

const FORMATS: Record<string, ExportRequest['format']> = {
  md: 'markdown',
  markdown: 'markdown',
  docx: 'docx',
  pdf: 'pdf',
};

function error(
  c: Context,
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
) {
  return c.json({ ok: false, error: { code, message, ...extra } }, status as 400);
}

function submitResponse(c: Context, out: SubmitOutcome) {
  switch (out.status) {
    case 'ack':
    case 'duplicate':
      return c.json({ ok: true, ...out });
    case 'conflict':
      return c.json(
        {
          ok: false,
          status: 'conflict',
          currentVersion: out.currentVersion,
          code: out.code,
          reason: out.reason,
        },
        409,
      );
    case 'rejected': {
      const forbidden = out.code === 'actor-mismatch' || out.code === 'actor-not-permitted';
      return c.json(
        { ok: false, status: 'rejected', code: out.code, reason: out.reason, errors: out.errors },
        forbidden ? 403 : 422,
      );
    }
  }
}

async function jsonBody<T>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw new HttpError(400, 'invalid-json', 'The request body is not valid JSON.');
  }
}

function intParam(v: string | undefined, name: string, def: number): number {
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0)
    throw new HttpError(400, 'invalid-parameter', `${name} must be a non-negative integer.`);
  return n;
}

/** Builds the Hono app. */
export function createApp(opts: AppOptions): Hono<Env> {
  const { service, auth } = opts;
  const app = new Hono<Env>();

  app.onError((err, c) => {
    if (err instanceof HttpError) return error(c, err.status, err.code, err.message, err.extra);
    if (err instanceof InvariantViolation) {
      console.error(err);
      return error(c, 500, 'invariant-violation', err.message);
    }
    console.error('[http] unhandled', err);
    return error(c, 500, 'internal', errMsg(err));
  });
  app.notFound((c) => error(c, 404, 'not-found', `No route for ${c.req.method} ${c.req.path}.`));

  app.use(
    '*',
    cors({
      origin: opts.corsOrigins ?? ['http://localhost:3100'],
      allowHeaders: ['authorization', 'content-type', 'last-event-id'],
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      exposeHeaders: ['content-disposition', 'x-longhand-final-url'],
      maxAge: 600,
    }),
  );
  app.use(
    '*',
    bodyLimit({
      maxSize: 8 * 1024 * 1024,
      onError: (c) => error(c, 413, 'too-large', 'The request body is too large.'),
    }),
  );

  // ------------------------------------------------------------------ public

  app.get('/healthz', (c) => c.json({ ok: true }));

  app.get('/.well-known/longhand-witness-key', (c) =>
    c.json({
      keyId: service.signer.keyId,
      publicKeyPem: service.signer.publicKeyPem,
      algorithm: 'ECDSA-P256-SHA256',
      signatureEncoding: 'ieee-p1363-base64',
      message: 'canonicalize({projectId, seq, hash, serverTime})',
    }),
  );

  // ---------------------------------------------------------------- internal

  app.post('/internal/sessions/:id/events', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return error(c, 400, 'invalid-draft', 'The body is not JSON.');
    }
    const r = await service.sessions.receive(
      c.req.param('id'),
      c.req.header('authorization') ?? null,
      body,
    );
    return c.json({ ok: true, seq: r.seq, commitId: r.commitId, duplicate: r.duplicate });
  });

  // ----------------------------------------------------------- authenticated

  const v1 = new Hono<Env>();
  v1.use('*', async (c, next) => {
    if (service.closing)
      throw new HttpError(503, 'shutting-down', 'The ledger service is shutting down.');
    const token = bearerToken(c.req.header('authorization'), c.req.query('access_token'));
    c.set('principal', await auth.authenticate(token));
    await next();
  });

  v1.get('/me', (c) => c.json({ ok: true, ...c.get('principal'), authMode: auth.mode }));

  // Projects
  v1.get('/projects', async (c) => {
    const rows = await service.listProjects(c.get('principal'));
    return c.json({ ok: true, projects: rows.map(({ streamPath: _s, ...r }) => r) });
  });

  v1.post('/projects', async (c) => {
    const body = await jsonBody<{
      title?: string;
      projectId?: string;
      draft?: CommitDraft;
      deviceId?: string;
      sessionId?: string;
    }>(c);
    const r = await service.createProject(c.get('principal'), body);
    return c.json({ ok: true, ...r }, r.duplicate ? 200 : 201);
  });

  v1.get('/projects/:pid', async (c) => {
    const ledger = await service.ledgerFor(c.get('principal'), c.req.param('pid'));
    const s = ledger.publicState;
    return c.json({
      ok: true,
      project: {
        projectId: ledger.projectId,
        accountId: ledger.accountId,
        title: s.settings.title,
        headSeq: ledger.headSeq,
        headHash: s.headHash,
        halted: ledger.haltedReason,
      },
    });
  });

  v1.get('/projects/:pid/state', async (c) => {
    const ledger = await service.ledgerFor(c.get('principal'), c.req.param('pid'));
    const state = ledger.publicState;
    return c.json({ ok: true, headSeq: state.headSeq, headHash: state.headHash, state });
  });

  v1.get('/projects/:pid/commits', async (c) => {
    const ledger = await service.ledgerFor(c.get('principal'), c.req.param('pid'));
    const after = intParam(c.req.query('after'), 'after', 0);
    const limit = Math.min(intParam(c.req.query('limit'), 'limit', 1000), 5000);
    const commits = ledger.commitsAfter(after).slice(0, limit);
    return c.json({ ok: true, headSeq: ledger.headSeq, commits });
  });

  // CommitTransport: submit
  v1.post('/projects/:pid/commits', async (c) => {
    const draft = await jsonBody<CommitDraft>(c);
    return submitResponse(c, await service.submit(c.get('principal'), c.req.param('pid'), draft));
  });

  // CommitTransport: fetchSince
  v1.get('/projects/:pid/documents/:did/updates', async (c) => {
    const ledger = await service.ledgerFor(c.get('principal'), c.req.param('pid'));
    const documentId = c.req.param('did');
    const h = ledger.history.get(documentId);
    if (!h) throw new HttpError(404, 'unknown-document', `There is no document ${documentId}.`);
    const since = intParam(c.req.query('since'), 'since', 0);
    const updates = h.since(since);
    if (!updates) {
      return c.json({
        ok: true,
        kind: 'snapshot',
        doc: nodeToJSON(h.doc) as PMNodeJSON,
        version: h.version,
      });
    }
    return c.json({ ok: true, kind: 'updates', updates, version: h.version });
  });

  // CommitTransport: subscribe (one document's step-bearing commits, in ledger order)
  v1.get('/projects/:pid/documents/:did/stream', async (c) => {
    const ledger = await service.ledgerFor(c.get('principal'), c.req.param('pid'));
    const documentId = c.req.param('did');
    const sinceParam = c.req.query('since');
    return sse(c, (out) => {
      const h = ledger.history.get(documentId);
      let last = -1;
      if (sinceParam !== undefined && h) {
        const since = intParam(sinceParam, 'since', 0);
        const backlog = h.since(since);
        if (backlog)
          for (const u of backlog) out.send({ event: 'update', data: u, id: String(u.seq) });
        else out.send({ event: 'snapshot', data: { doc: nodeToJSON(h.doc), version: h.version } });
        last = h.version;
      }
      return ledger.subscribe((a) => {
        const u = a.update;
        if (!u || u.documentId !== documentId || u.version <= last) return;
        out.send({ event: 'update', data: u, id: String(u.seq) });
      });
    });
  });

  // Project-wide event stream (every commit, in ledger order)
  v1.get('/projects/:pid/events', async (c) => {
    const ledger = await service.ledgerFor(c.get('principal'), c.req.param('pid'));
    const lastId = c.req.header('last-event-id');
    const after = intParam(c.req.query('after') ?? lastId, 'after', ledger.headSeq);
    return sse(c, (out) => {
      for (const commit of ledger.commitsAfter(after))
        out.send({ event: 'commit', data: commit, id: String(commit.seq) });
      return ledger.subscribe((a) =>
        out.send({ event: 'commit', data: a.commit, id: String(a.commit.seq) }),
      );
    });
  });

  // Feedback and Discuss
  const startSession =
    (type: 'FeedbackRequested' | 'DiscussRequested') => async (c: Context<Env>) => {
      const body = await jsonBody<{ draft?: CommitDraft } & Partial<CommitDraft>>(c);
      const draft = (body.draft ?? body) as CommitDraft;
      const { outcome, session } = await service.requestSession(
        c.get('principal'),
        c.req.param('pid') as string,
        draft,
        type,
      );
      if (!session) return submitResponse(c, outcome);
      return c.json(
        {
          ok: true,
          status: outcome.status,
          seq: 'seq' in outcome ? outcome.seq : null,
          sessionId: session.id,
        },
        outcome.status === 'ack' ? 201 : 200,
      );
    };
  v1.post('/projects/:pid/feedback', startSession('FeedbackRequested'));
  v1.post('/projects/:pid/discuss', startSession('DiscussRequested'));

  v1.get('/projects/:pid/sessions/:sid', async (c) => {
    const principal = c.get('principal');
    const s = service.sessionFor(principal, c.req.param('pid'), c.req.param('sid'));
    const ledger = await service.ledgerFor(principal, s.projectId);
    return c.json({
      ok: true,
      session: {
        id: s.id,
        kind: s.kind,
        requestId: s.requestId,
        threadId: s.threadId,
        phase: s.phase,
        ended: s.ended,
        folded: ledger.publicState.annotations.agentSessions[s.id] ?? null,
      },
    });
  });

  v1.get('/projects/:pid/sessions/:sid/events', (c) => {
    const s = service.sessionFor(c.get('principal'), c.req.param('pid'), c.req.param('sid'));
    return sse(c, (out) =>
      service.sessions.subscribe(s, (e: SessionStreamEvent) => {
        out.send({ event: e.kind, data: e });
        if (e.kind === 'ended') out.end();
      }),
    );
  });

  v1.post('/projects/:pid/sessions/:sid/cancel', async (c) => {
    const s = service.sessionFor(c.get('principal'), c.req.param('pid'), c.req.param('sid'));
    await service.sessions.cancel(s);
    return c.json({ ok: true, sessionId: s.id, phase: s.phase });
  });

  // Research
  v1.get('/research/search', async (c) => {
    const q = (c.req.query('q') ?? '').trim();
    if (!q) throw new HttpError(400, 'invalid-parameter', 'q is required.');
    const limit = Math.min(Math.max(intParam(c.req.query('limit'), 'limit', 5), 1), 10);
    const search = service.opts.search;
    if (!search) throw new HttpError(503, 'search-unavailable', 'Source search is not configured.');
    const candidates = await search.search(q.slice(0, 300), limit);
    return c.json({ ok: true, candidates });
  });

  v1.get('/research/page', async (c) => {
    const url = c.req.query('url');
    if (!url) throw new HttpError(400, 'invalid-parameter', 'url is required.');
    try {
      const page = await fetchPublicPage(url, opts.pageFetch);
      return new Response(page.body, {
        status: page.status,
        headers: { 'content-type': page.contentType, 'x-longhand-final-url': page.finalUrl },
      });
    } catch (e) {
      if (e instanceof BlockedUrlError) throw new HttpError(400, 'blocked-url', e.message);
      throw new HttpError(502, 'fetch-failed', `Could not fetch the page: ${errMsg(e)}`);
    }
  });

  // Export
  const exportRoute = async (c: Context<Env>, req: ExportRequest) => {
    const ledger = await service.ledgerFor(c.get('principal'), c.req.param('pid') as string);
    let file;
    try {
      file = await renderExport(ledger.publicState, req);
    } catch (e) {
      if (/unknown document/.test(errMsg(e)))
        throw new HttpError(404, 'unknown-document', errMsg(e));
      throw e;
    }
    return new Response(Buffer.from(file.bytes), {
      headers: {
        'content-type': file.mimeType,
        'content-disposition': `attachment; filename="${file.filename.replace(/["\\\r\n]/g, '_')}"`,
      },
    });
  };
  v1.get('/projects/:pid/export', (c) => {
    const format = FORMATS[(c.req.query('format') ?? 'md').toLowerCase()];
    if (!format) throw new HttpError(400, 'invalid-parameter', 'format must be md, docx or pdf.');
    const docs = c.req.query('documents');
    const style = c.req.query('style');
    return exportRoute(c, {
      format,
      ...(docs ? { documentIds: docs.split(',').filter(Boolean) } : {}),
      ...(style ? { style } : {}),
    });
  });
  v1.post('/projects/:pid/export', async (c) => {
    const body = await jsonBody<{
      format?: string;
      documentIds?: string[];
      style?: string;
      author?: string;
      provenance?: ProvenanceSummary | null;
    }>(c);
    const format = FORMATS[(body.format ?? 'md').toLowerCase()];
    if (!format) throw new HttpError(400, 'invalid-parameter', 'format must be md, docx or pdf.');
    return exportRoute(c, {
      format,
      ...(body.documentIds ? { documentIds: body.documentIds } : {}),
      ...(body.style ? { style: body.style } : {}),
      ...(body.author ? { author: body.author } : {}),
      ...(body.provenance ? { provenance: body.provenance } : {}),
    });
  });

  // Bundle data (the report lane builds the bundle and report on top)
  v1.get('/projects/:pid/bundle', async (c) => {
    const data = await service.bundleData(c.get('principal'), c.req.param('pid'));
    return c.json({ ok: true, ...data });
  });

  app.route('/v1', v1);
  return app;
}
