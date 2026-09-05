import { Writable } from 'node:stream';
import Fastify, { LogController } from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  categorizeError,
  createLogger,
  FORBIDDEN_LOG_KEYS,
  sanitizeRequestUrl,
  serializeRequest,
} from '../../src/observability/logger.ts';

// OPS-563 to OPS-573 (unit): structure, correlation and redaction of protected values.

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  const records = () => lines.filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>);
  return { stream, lines, records };
}

describe('Structured logging', () => {
  it('redacts the minimum price, concession limits, acquisition cost and secrets at any depth', () => {
    const { stream, lines } = capture();
    const log = createLogger({ module: 'web', env: 'ci', release: 'test', stream });
    log.info(
      {
        password: 'pw-secret-1',
        accessCode: '123456',
        session_token: 'tok-secret-2',
        databaseUrl: 'postgresql://user:pw@host/db',
        listing: {
          minimum_price_minor: 20000,
          policy: { minimumPrice: { amountMinor: 20001 }, max_autonomous_concession_minor: 500 },
          item: { acquisition_cost_minor: 15000 },
        },
        safe_field: 'visible',
      },
      'accidental record',
    );
    const out = lines.join('');
    for (const secret of [
      'pw-secret-1',
      '123456',
      'tok-secret-2',
      '20000',
      '20001',
      '500',
      '15000',
      'user:pw',
    ]) {
      expect(out, secret).not.toContain(secret);
    }
    expect(out).toContain('"safe_field":"visible"');
    expect(out).toContain('[REDACTED]');
    expect(FORBIDDEN_LOG_KEYS).toContain('minimum_price_minor');
  });

  it('redacts an access code wherever an issued-code record is logged by mistake (SEC-040, OPS-566)', () => {
    const { stream, lines } = capture();
    const log = createLogger({ module: 'web', env: 'ci', release: 'test', stream });
    const issued = { id: 'code-id', versionNumber: 1, status: 'ACTIVE', plaintextCode: '042917' };
    log.info({ result: { listing: { status: 'LISTED' }, code: issued } }, 'publication');
    log.info({ code: issued }, 'code');
    log.info({ plaintextCode: '042917', plaintext_code: '042917', code_hash: '$scrypt$x' }, 'flat');
    log.info({ published: { copyBlock: { text: 'Access code: 042917', buyerUrl: 'x' } } }, 'block');
    const out = lines.join('');
    expect(out).not.toContain('042917');
    expect(out).not.toContain('$scrypt$');
    expect(out).toContain('"status":"LISTED"');
    for (const key of ['plaintextCode', 'plaintext_code', 'code', 'code_hash', 'copyBlock', 'copy_block']) {
      expect(FORBIDDEN_LOG_KEYS).toContain(key);
    }
  });

  it('classifies errors without interpolating data into the message', () => {
    expect(categorizeError(Object.assign(new Error('x'), { code: '40001' }))).toEqual({
      error_category: 'transient',
      error_type: 'pg:40001',
    });
    expect(categorizeError(Object.assign(new Error('x'), { code: '42501' }))).toEqual({
      error_category: 'permanent',
      error_type: 'Error',
    });
    expect(categorizeError(Object.assign(new Error('x'), { name: 'ZodError' }))).toEqual({
      error_category: 'validation',
      error_type: 'ZodError',
    });
    expect(categorizeError('not an error')).toEqual({ error_category: 'unknown', error_type: 'string' });
  });

  it('carries the request id on every request log line and exposes it in the response', async () => {
    const { stream, records } = capture();
    const log = createLogger({ module: 'web', env: 'ci', release: 'test', stream });
    const app = Fastify({
      loggerInstance: log,
      genReqId: () => 'req-fixed-1',
      logController: new LogController({ requestIdLogLabel: 'request_id' }),
    });
    app.addHook('onSend', (request, reply, _payload, done) => {
      reply.header('x-request-id', request.id);
      done();
    });
    app.get('/ping', (request) => {
      request.log.info({ step: 'handler' }, 'ping');
      return { ok: true };
    });
    const res = await app.inject({ method: 'GET', url: '/ping' });
    await app.close();
    expect(res.headers['x-request-id']).toBe('req-fixed-1');
    const withRequest = records().filter((r) => 'request_id' in r);
    expect(withRequest.length).toBeGreaterThanOrEqual(3);
    for (const r of withRequest) expect(r['request_id']).toBe('req-fixed-1');
  });

  it('logs a request as its method, query-free path and route template, and never throws on a malformed target (OPS-563, OPS-567)', async () => {
    for (const [target, path] of [
      ['/seller/listings', '/seller/listings'],
      ['/seller/listings?limit=1&cursor=eyJ2IjoxfQ', '/seller/listings'],
      ['/seller/listings?limit=1&limit=2&%zz=1', '/seller/listings'],
      ['/seller/listings/%E2%9C%93?x=1', '/seller/listings/%E2%9C%93'],
      ['/seller/listings%3F?cursor=abc', '/seller/listings%3F'],
      ['/a#frag?x=1', '/a'],
      ['/a?x=1#frag', '/a'],
      ['?cursor=abc', ''],
      ['http://seller.example/seller/listings?cursor=abc', '/seller/listings'],
      ['https://seller.example:8443/x?y', '/x'],
      ['http://seller.example?cursor=abc', '/'],
      ['//evil.example/path?x=1', '//evil.example/path'],
      ['*', '*'],
      ['', ''],
    ] as const) {
      expect(sanitizeRequestUrl(target), target).toBe(path);
    }
    for (const odd of [undefined, null, 42, {}, [], Symbol('x'), () => 'x', 'x'.repeat(10_000) + '?y=1']) {
      expect(() => sanitizeRequestUrl(odd)).not.toThrow();
      expect(sanitizeRequestUrl(odd)).not.toContain('?');
      expect(sanitizeRequestUrl(odd).length).toBeLessThanOrEqual(2048);
    }
    expect(serializeRequest({ method: 'GET', url: '/p?q=1', routeOptions: { url: '/p' } })).toEqual({
      method: 'GET',
      url: '/p',
      route: '/p',
    });
    expect(
      serializeRequest({ method: 'GET', url: '/p?q=1', headers: { cookie: 'c=1' }, ip: '203.0.113.1' }),
    ).toEqual({
      method: 'GET',
      url: '/p',
    });
    const throwing = Object.defineProperty({}, 'routeOptions', {
      get() {
        throw new Error('no context yet');
      },
    });
    for (const odd of [undefined, null, 42, 'text', {}, { url: 7, method: 9, routeOptions: 'x' }, throwing]) {
      expect(() => serializeRequest(odd)).not.toThrow();
      expect(JSON.stringify(serializeRequest(odd))).not.toContain('?');
    }
    // Through Fastify: the incoming-request line carries the sanitized shape, at every outcome.
    const { stream, records, lines } = capture();
    const log = createLogger({ module: 'web', env: 'ci', release: 'test', stream });
    const app = Fastify({
      loggerInstance: log,
      logController: new LogController({ requestIdLogLabel: 'request_id' }),
    });
    // As in the application: a custom not-found handler, since Fastify's own fallback interpolates
    // the raw request target into its log message.
    app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: 'not_found' }));
    app.get('/ping', () => ({ ok: true }));
    for (const url of [
      '/ping?secret=shh-1&cursor=eyJ2IjoxfQ',
      '/nope?secret=shh-2',
      'http://h.example/ping?secret=shh-3',
      '/ping?a=1&a=2&%zz',
    ]) {
      await app.inject({ method: 'GET', url, headers: { cookie: 'session=shh-4' } });
    }
    await app.close();
    const out = lines.join('');
    expect(out).not.toMatch(/shh-|secret|cursor|eyJ2|%zz/);
    const reqs = records()
      .map((r) => r['req'] as Record<string, unknown> | undefined)
      .filter((r): r is Record<string, unknown> => r !== undefined);
    expect(reqs.length).toBeGreaterThanOrEqual(4);
    for (const req of reqs) {
      expect(String(req['url'])).not.toMatch(/[?&=#]/);
      expect(Object.keys(req).sort()).toEqual(expect.arrayContaining(['method', 'url']));
      expect(req).not.toHaveProperty('headers');
      expect(req).not.toHaveProperty('remoteAddress');
    }
    expect(reqs.map((r) => r['url'])).toEqual(expect.arrayContaining(['/ping', '/nope']));
    expect(reqs.map((r) => r['route'])).toContain('/ping');
  });

  it('redacts session tokens, token hashes, anti-forgery values, addresses, cookies and forwarding headers (D-19, OPS-567, OPS-568)', () => {
    const { stream, lines } = capture();
    const log = createLogger({ module: 'web', env: 'ci', release: 'test', stream });
    log.info(
      {
        token: 'tok-secret-3',
        tokenHash: 'hash-secret-4',
        antiForgery: 'af-secret-5',
        email: ['someone', 'synthetic.invalid'].join('@'),
        ip: '203.0.113.77',
        req: {
          remoteAddress: '203.0.113.78',
          headers: { cookie: 'c=6', 'x-forwarded-for': '203.0.113.79', forwarded: 'for=203.0.113.80' },
        },
        res: { headers: { 'set-cookie': '__Host-seller_session=tok-secret-7' } },
        nested: {
          deeper: {
            session_token: 'tok-secret-8',
            token_hash: 'hash-secret-9',
            x: { anti_forgery: 'af-secret-10' },
          },
        },
        safe_field: 'visible',
      },
      'accidental record',
    );
    const out = lines.join('');
    for (const secret of [
      'tok-secret',
      'hash-secret',
      'af-secret',
      'synthetic.invalid',
      '203.0.113',
      'c=6',
    ]) {
      expect(out, secret).not.toContain(secret);
    }
    expect(out).toContain('"safe_field":"visible"');
    for (const key of [
      'token',
      'tokenHash',
      'antiForgery',
      'email',
      'ip',
      'remoteAddress',
      'x-forwarded-for',
      'forwarded',
      'set-cookie',
    ]) {
      expect(FORBIDDEN_LOG_KEYS).toContain(key);
    }
  });
});
