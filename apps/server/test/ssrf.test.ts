import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BlockedUrlError,
  fetchPublicPage,
  isPrivateAddress,
  validatePublicUrl,
} from '../src/research/ssrf';
import { startTestServer, type TestServer } from '../src/testing';
import { DB, api } from './helpers';

describe('isPrivateAddress', () => {
  it.each([
    '127.0.0.1',
    '127.1.2.3',
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '198.18.0.1',
    '::1',
    '::',
    'fe80::1',
    'fc00::1',
    'fd12:3456::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    '64:ff9b::a00:1',
    'ff02::1',
    '2001:db8::1',
    'not-an-ip',
  ])('blocks %s', (a) => expect(isPrivateAddress(a)).toBe(true));

  it.each(['93.184.215.14', '8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111'])(
    'allows %s',
    (a) => expect(isPrivateAddress(a)).toBe(false),
  );
});

describe('validatePublicUrl', () => {
  it.each([
    'file:///etc/passwd',
    'ftp://example.com/',
    'gopher://example.com/',
    'javascript:alert(1)',
    'http://user:pw@example.com/',
    'http://localhost/',
    'http://LOCALHOST./',
    'http://app.localhost/',
    'http://printer.local/',
    'http://metadata.google.internal/',
    'http://127.0.0.1/',
    'http://[::1]/',
    'http://[::ffff:7f00:1]/',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.1.2.3:8080/',
    'http://example.com:22/',
    'http://example.com:6379/',
    'http://intranet/',
    'not a url',
  ])('refuses %s', (u) => expect(() => validatePublicUrl(u)).toThrow(BlockedUrlError));

  it.each([
    'https://example.com/',
    'http://example.com:8080/a?b=c',
    'https://en.wikipedia.org/wiki/Ledger',
  ])('accepts %s', (u) => expect(validatePublicUrl(u).href).toBe(new URL(u).href));
});

describe('fetchPublicPage', () => {
  let server: Server;
  let origin: string;
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/page') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(
          '<html><head><title>A page</title><meta name="citation_title" content="On Ledgers"></head></html>',
        );
      } else if (req.url === '/to-private') {
        res.writeHead(302, {
          location: `http://localhost:${(server.address() as AddressInfo).port}/page`,
        });
        res.end();
      } else if (req.url === '/json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      } else if (req.url === '/big') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('x'.repeat(5000));
      } else {
        res.writeHead(404, { 'content-type': 'text/html' });
        res.end('<html>nope</html>');
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  const allow = () => ({ allowHosts: [new URL(origin).host] });

  it('refuses a public-looking name that resolves to a private address (checked at connect time)', async () => {
    const resolver = async () => [{ address: '10.0.0.7', family: 4 }];
    await expect(fetchPublicPage('http://evil.example.com/', { resolver })).rejects.toThrow(
      /not public/,
    );
    const mixed = async () => [
      { address: '93.184.215.14', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ];
    await expect(
      fetchPublicPage('http://rebind.example.com/', { resolver: mixed }),
    ).rejects.toThrow(/not public/);
  });

  it('fetches an HTML page (test host allow-listed) and re-checks every redirect', async () => {
    const page = await fetchPublicPage(`${origin}/page`, allow());
    expect(page.status).toBe(200);
    expect(page.body).toContain('citation_title');
    await expect(fetchPublicPage(`${origin}/to-private`, allow())).rejects.toThrow(BlockedUrlError);
    await expect(fetchPublicPage(`${origin}/json`, allow())).rejects.toThrow(/not an HTML page/);
    await expect(fetchPublicPage(`${origin}/big`, { ...allow(), maxBytes: 1000 })).rejects.toThrow(
      /larger/,
    );
    expect((await fetchPublicPage(`${origin}/missing`, allow())).status).toBe(404);
  });

  describe.skipIf(!DB())('through the proxy route', () => {
    let t: TestServer;
    beforeAll(async () => {
      t = await startTestServer({ pageFetch: allow() });
    });
    afterAll(async () => {
      await t?.close();
    });

    it('proxies an allowed page and refuses private targets with 400 blocked-url', async () => {
      const ok = await fetch(
        `${t.url}/v1/research/page?url=${encodeURIComponent(`${origin}/page`)}`,
      );
      expect(ok.status).toBe(200);
      expect(ok.headers.get('content-type')).toMatch(/text\/html/);
      expect(await ok.text()).toContain('On Ledgers');
      for (const target of [
        'http://127.0.0.1:3200/v1/projects',
        'http://169.254.169.254/',
        'file:///etc/passwd',
        `${t.url}/healthz`,
      ]) {
        const r = await api<{ error: { code: string } }>(
          t,
          'GET',
          `/v1/research/page?url=${encodeURIComponent(target)}`,
        );
        expect(r.status, target).toBe(400);
        expect(r.body.error.code).toBe('blocked-url');
      }
      expect((await api(t, 'GET', '/v1/research/page')).status).toBe(400);
    });

    it('serves source search from the configured SourceSearch', async () => {
      const r = await api<{ candidates: unknown[] }>(
        t,
        'GET',
        '/v1/research/search?q=ledgers&limit=3',
      );
      expect(r.status).toBe(200);
      expect(r.body.candidates).toEqual([]);
      expect((await api(t, 'GET', '/v1/research/search')).status).toBe(400);
    });
  });
});
