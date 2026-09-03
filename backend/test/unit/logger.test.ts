import { Writable } from 'node:stream';
import Fastify, { LogController } from 'fastify';
import { describe, expect, it } from 'vitest';
import { categorizeError, createLogger, FORBIDDEN_LOG_KEYS } from '../../src/observability/logger.ts';

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
});
