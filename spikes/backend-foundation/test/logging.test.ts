import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import Fastify, { LogController } from 'fastify';
import { categorizeError, createLogger, FORBIDDEN_LOG_KEYS, logJobOutcome } from '../src/observability/logger.ts';

// Proof 9 — structured observability (unit). Structural only: no external service.

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  const records = () => lines.filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>);
  return { stream, lines, records };
}

describe('Structured logging', () => {
  it('job records carry job id, attempt, outcome and error category as fixed fields', () => {
    const { stream, records } = capture();
    const log = createLogger({ module: 'worker', stream });
    logJobOutcome(log, { request_id: 'req-1', job_id: 'job-1', job_name: 'spike_demo', job_attempt: 2, seller_id: 'seller-1', outcome: 'completed', duration_ms: 12 });
    logJobOutcome(log, { job_id: 'job-2', job_name: 'spike_demo', job_attempt: 1, outcome: 'failed', ...categorizeError(new Error('boom')) });
    const [ok, failed] = records();
    expect(ok).toMatchObject({ module: 'worker', env: 'spike', release: 'spike', severity: 'info', request_id: 'req-1', job_id: 'job-1', job_name: 'spike_demo', job_attempt: 2, outcome: 'completed', duration_ms: 12, msg: 'job outcome' });
    expect(failed).toMatchObject({ severity: 'warn', job_id: 'job-2', job_attempt: 1, outcome: 'failed', error_category: 'permanent', error_type: 'Error' });
    expect(typeof ok?.['time']).toBe('string');
  });

  it('classifies errors without interpolating data into the message', () => {
    expect(categorizeError(Object.assign(new Error('x'), { code: '40001' }))).toEqual({ error_category: 'transient', error_type: 'pg:40001' });
    expect(categorizeError(Object.assign(new Error('x'), { code: '08006' }))).toEqual({ error_category: 'transient', error_type: 'pg:08006' });
    expect(categorizeError(Object.assign(new Error('x'), { code: '42501' }))).toEqual({ error_category: 'permanent', error_type: 'Error' });
    expect(categorizeError(Object.assign(new Error('x'), { name: 'ZodError' }))).toEqual({ error_category: 'validation', error_type: 'ZodError' });
    expect(categorizeError('not an error')).toEqual({ error_category: 'unknown', error_type: 'string' });
  });

  it('redacts secrets and protected seller fields at any depth, even when passed by mistake', () => {
    const { stream, lines } = capture();
    const log = createLogger({ module: 'web', stream });
    log.info(
      {
        password: 'pw-secret-1',
        accessCode: '123456',
        session_token: 'tok-secret-2',
        nested: { sessionToken: 'tok-secret-3', deeper: { access_code: '654321', listing: { minimumPriceMinor: 20000, internalNotes: 'PRIVATE notes' } } },
        connectionString: 'postgresql://user:pw@host/db',
        safe_field: 'visible',
      },
      'accidental record',
    );
    const out = lines.join('');
    for (const secret of ['pw-secret-1', '123456', 'tok-secret-2', 'tok-secret-3', '654321', '20000', 'PRIVATE notes', 'postgresql://user:pw']) {
      expect(out, secret).not.toContain(secret);
    }
    expect(out).toContain('"safe_field":"visible"');
    expect(out).toContain('[REDACTED]');
    expect(FORBIDDEN_LOG_KEYS).toContain('accessCode');
  });

  it('every request log line carries the request id that the response exposes', async () => {
    const { stream, records } = capture();
    const log = createLogger({ module: 'web', stream });
    const app = Fastify({ loggerInstance: log, genReqId: () => 'req-fixed-1', logController: new LogController({ requestIdLogLabel: 'request_id' }) });
    app.addHook('onSend', async (request, reply) => {
      reply.header('x-request-id', request.id);
    });
    app.get('/ping', async (request) => {
      request.log.info({ step: 'handler' }, 'ping');
      return { ok: true };
    });
    const res = await app.inject({ method: 'GET', url: '/ping' });
    await app.close();
    expect(res.headers['x-request-id']).toBe('req-fixed-1');
    const withRequest = records().filter((r) => 'request_id' in r);
    expect(withRequest.length).toBeGreaterThanOrEqual(3); // incoming request, handler line, request completed
    for (const r of withRequest) expect(r['request_id']).toBe('req-fixed-1');
    expect(withRequest.some((r) => r['msg'] === 'ping' && r['step'] === 'handler')).toBe(true);
  });
});
