/**
 * The page-metadata proxy behind the browser's `pageFetch` (research lane: pages
 * do not allow cross-origin reads), with an SSRF guard.
 *
 * - Only `http:` and `https:` URLs, no credentials, ports 80/443/8080/8443 only.
 * - Host names like `localhost`, `*.localhost`, `*.local`, `*.internal` and
 *   `*.home.arpa` are refused outright.
 * - Every address the host resolves to must be public: loopback, private,
 *   link-local, CGNAT, multicast, documentation, benchmarking, reserved and
 *   IPv4-mapped/NAT64 forms of those are refused.
 * - The check runs in the socket's `lookup`, so the connection goes to the
 *   address that was checked (no DNS-rebinding window).
 * - Redirects are followed by hand (at most 5), re-checking every hop.
 * - Responses are capped at 2 MB and 10 s, and only HTML/XHTML is returned.
 */
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { USER_AGENT } from '@longhand/research';

// Separate lists: an IPv6 rule covering ::ffff:0:0/96 would also match every IPv4 address.
const blocked4 = new BlockList();
const blocked6 = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked4.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 32],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const) {
  blocked6.addSubnet(net, prefix, 'ipv6');
}

/** True if `address` (an IPv4 or IPv6 literal) is not a public unicast address. */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blocked4.check(address, 'ipv4');
  if (family === 6) {
    const lower = address.toLowerCase();
    // IPv4-mapped (::ffff:a.b.c.d or ::ffff:7f00:1) and IPv4-compatible forms: refuse them all.
    if (/^(0{0,4}:){0,5}:?ffff:/.test(lower) || /^::\d+\.\d+\.\d+\.\d+$/.test(lower)) return true;
    return blocked6.check(lower, 'ipv6');
  }
  return true;
}

const ALLOWED_PORTS = new Set(['', '80', '443', '8080', '8443']);
const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa', '.localdomain'];

/** Why a URL was refused. */
export class BlockedUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlockedUrlError';
  }
}

/** Parses and checks a URL without resolving it. Throws {@link BlockedUrlError}. */
export function validatePublicUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedUrlError('not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BlockedUrlError(`scheme ${url.protocol} is not allowed`);
  }
  if (url.username || url.password)
    throw new BlockedUrlError('URLs with credentials are not allowed');
  if (!ALLOWED_PORTS.has(url.port)) throw new BlockedUrlError(`port ${url.port} is not allowed`);
  const host = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (!host) throw new BlockedUrlError('missing host');
  if (host === 'localhost' || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) {
    throw new BlockedUrlError(`host ${host} is not public`);
  }
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new BlockedUrlError(`address ${host} is not public`);
  } else if (!host.includes('.')) {
    throw new BlockedUrlError(`host ${host} is not a public domain name`);
  }
  return url;
}

/** DNS lookup that refuses non-public answers (exported for tests). */
export type Resolver = (host: string) => Promise<LookupAddress[]>;

const systemResolver: Resolver = (host) =>
  new Promise((resolve, reject) => {
    dnsLookup(host, { all: true, verbatim: true }, (err, addresses) =>
      err ? reject(err) : resolve(addresses),
    );
  });

function guardedLookup(resolver: Resolver): LookupFunction {
  return (hostname, options, callback) => {
    const host = hostname.replace(/^\[|\]$/g, '');
    const done = callback as (
      err: NodeJS.ErrnoException | null,
      address: string | LookupAddress[],
      family?: number,
    ) => void;
    const answer = isIP(host)
      ? Promise.resolve([{ address: host, family: isIP(host) }])
      : resolver(host);
    answer.then(
      (addresses) => {
        if (addresses.length === 0) return done(new BlockedUrlError(`${host} did not resolve`), '');
        const bad = addresses.find((a) => isPrivateAddress(a.address));
        if (bad)
          return done(
            new BlockedUrlError(`${host} resolves to ${bad.address}, which is not public`),
            '',
          );
        if ((options as { all?: boolean }).all) return done(null, addresses);
        const first = addresses[0] as LookupAddress;
        return done(null, first.address, first.family);
      },
      (e: NodeJS.ErrnoException) => done(e, ''),
    );
  };
}

/** Result of {@link fetchPublicPage}. */
export interface PageResponse {
  status: number;
  contentType: string;
  finalUrl: string;
  body: string;
}

/** Options for {@link fetchPublicPage}. */
export interface PageFetchOptions {
  resolver?: Resolver;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  /** Test hook: allow these exact hosts even if private (e.g. a local fixture server). Never set in production. */
  allowHosts?: readonly string[];
}

function once(
  url: URL,
  opts: Required<Omit<PageFetchOptions, 'allowHosts'>> & { allow: boolean },
): Promise<{
  res: IncomingMessage;
  body: Buffer;
}> {
  const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: 'GET',
        headers: {
          'user-agent': USER_AGENT,
          accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
        },
        ...(opts.allow ? {} : { lookup: guardedLookup(opts.resolver) }),
        timeout: opts.timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let failed = false;
        res.on('data', (c: Buffer) => {
          if (failed) return;
          size += c.length;
          if (size > opts.maxBytes) {
            failed = true;
            reject(new BlockedUrlError(`response larger than ${opts.maxBytes} bytes`));
            res.destroy();
            req.destroy();
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          if (!failed) resolve({ res, body: Buffer.concat(chunks) });
        });
        res.on('error', (e) => {
          if (!failed) reject(e);
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error(`timed out after ${opts.timeoutMs} ms`)));
    req.on('error', reject);
    req.end();
  });
}

/** Fetches a public HTML page (see the module comment for the rules). */
export async function fetchPublicPage(
  raw: string,
  options: PageFetchOptions = {},
): Promise<PageResponse> {
  const opts = {
    resolver: options.resolver ?? systemResolver,
    timeoutMs: options.timeoutMs ?? 10_000,
    maxBytes: options.maxBytes ?? 2_000_000,
    maxRedirects: options.maxRedirects ?? 5,
  };
  const allowHosts = new Set(options.allowHosts ?? []);
  let current = raw;
  for (let hop = 0; hop <= opts.maxRedirects; hop++) {
    let url: URL;
    const allow = (() => {
      try {
        return allowHosts.has(new URL(current).host);
      } catch {
        return false;
      }
    })();
    if (allow) url = new URL(current);
    else url = validatePublicUrl(current);
    const { res, body } = await once(url, { ...opts, allow });
    const status = res.statusCode ?? 0;
    const location = res.headers.location;
    if (status >= 300 && status < 400 && location) {
      current = new URL(location, url).toString();
      continue;
    }
    const contentType = String(res.headers['content-type'] ?? '');
    if (status < 400 && !/^(text\/html|application\/xhtml\+xml)/i.test(contentType)) {
      throw new BlockedUrlError(`not an HTML page (${contentType || 'no content type'})`);
    }
    return {
      status,
      contentType: contentType || 'text/html',
      finalUrl: url.toString(),
      body: body.toString('utf8'),
    };
  }
  throw new BlockedUrlError(`more than ${opts.maxRedirects} redirects`);
}
