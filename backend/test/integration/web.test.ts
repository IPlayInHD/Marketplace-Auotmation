import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type DbHandle } from '../../src/db/kysely.ts';
import { createLogger } from '../../src/observability/logger.ts';
import { buildWebApp, ROUTE_PREFIXES, type WebApp } from '../../src/web/app.ts';
import { startDatabase, type TestDatabase } from '../helpers/database.ts';

// The web skeleton: health over the runtime role, request correlation, and no seller or buyer
// route in this slice (D-18 boundaries, AUTH-222 deny by default).

describe('Web process', () => {
  let env: TestDatabase;
  let runtime: DbHandle;
  let app: WebApp;
  const lines: string[] = [];

  beforeAll(async () => {
    env = await startDatabase();
    runtime = createDb(env.runtimeUrl, { max: 2, applicationName: 'web-test' });
    const stream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    });
    app = await buildWebApp({
      db: runtime.db,
      logger: createLogger({ module: 'web', env: 'ci', release: 'test', stream }),
    });
    await app.ready();
  });
  afterAll(async () => {
    await app?.close();
    await runtime?.close();
    await env?.stop();
  });

  it('answers /health through the runtime role and exposes the request id', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', database: 'reachable' });
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('registers no seller route and no buyer route', async () => {
    expect(app.hasRoute({ method: 'GET', url: '/health' })).toBe(true);
    for (const url of [
      `${ROUTE_PREFIXES.buyer}/:publicId`,
      `${ROUTE_PREFIXES.buyer}`,
      `${ROUTE_PREFIXES.seller}/listings`,
      `${ROUTE_PREFIXES.seller}`,
      '/signup',
      '/login',
    ]) {
      expect(app.hasRoute({ method: 'GET', url }), url).toBe(false);
      expect(app.hasRoute({ method: 'POST', url }), url).toBe(false);
    }
    for (const url of [
      `${ROUTE_PREFIXES.buyer}/abcdefghijklmnop`,
      `${ROUTE_PREFIXES.seller}/listings`,
      '/signup',
    ]) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(404);
    }
  });

  it('logs with fixed fields and never a connection string', () => {
    const out = lines.join('');
    expect(out).toContain('"module":"web"');
    expect(out).not.toContain(env.runtimeUrl);
    expect(out).not.toMatch(/postgresql:\/\/[^@]*:[^@]*@/);
  });
});
