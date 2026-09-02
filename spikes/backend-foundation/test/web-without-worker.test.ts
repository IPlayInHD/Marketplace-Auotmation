import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROLES } from '../src/db/constants.ts';
import { createDb, type DbHandle } from '../src/db/kysely.ts';
import { createLogger } from '../src/observability/logger.ts';
import { buildWebApp, type WebApp } from '../src/web/app.ts';
import { DEMO_LISTING, startSpikeDatabase, type SpikeDatabase } from './helpers/database.ts';
import { query } from './helpers/inspect.ts';

// Proof 7 — the web entry point serves /health and the server-rendered buyer page while no
// worker process exists anywhere.

describe('Web without worker', () => {
  let env: SpikeDatabase;
  let web: DbHandle;
  let app: WebApp;
  let baseUrl: string;
  beforeAll(async () => {
    env = await startSpikeDatabase();
    web = createDb(env.webUrl, 2, 'spike-web-p7');
    app = buildWebApp({ db: web.db, logger: createLogger({ module: 'web', level: 'warn' }), demo: env.demo });
    baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
  });
  afterAll(async () => {
    await app?.close();
    await web?.close();
    await env?.stop();
  });

  it('no worker process or worker-role session exists', async () => {
    const sessions = await query<{ usename: string; application_name: string }>(
      env.superuserUrl,
      `SELECT usename, application_name FROM pg_stat_activity WHERE usename = $1 OR application_name ILIKE '%worker%'`,
      [ROLES.worker],
    );
    expect(sessions).toEqual([]);
  });

  it('the web module graph does not import pg-boss or the worker', async () => {
    const webDir = fileURLToPath(new URL('../src/web/', import.meta.url));
    const files = (await readdir(webDir)).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const source = await readFile(path.join(webDir, f), 'utf8');
      expect(source, f).not.toMatch(/from ['"]pg-boss['"]/);
      expect(source, f).not.toMatch(/\.\.\/worker\//);
      expect(source, f).not.toMatch(/\.\.\/jobs\//);
    }
  });

  it('GET /health returns 200 over a real socket bound to loopback', async () => {
    expect(baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', database: 'reachable', worker_required: false });
    expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('GET /buyer/demo returns server-rendered HTML containing only buyer-safe fields', async () => {
    const res = await fetch(`${baseUrl}/buyer/demo`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/html/);
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('x-robots-tag')).toBe('noindex');
    const html = await res.text();
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain(DEMO_LISTING.title);
    expect(html).toContain(DEMO_LISTING.sellerDisplayName);
    expect(html).toContain('EUR 250.00');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('PRIVATE');
    expect(html).not.toContain(DEMO_LISTING.internalNotes);
    expect(html).not.toContain('200.00'); // the minimum price
    expect(html).not.toContain(String(DEMO_LISTING.minimumPriceMinor));
    expect(html).not.toContain(env.demo.sellerId);
  });

  it('the same routes answer through inject as well, with request correlation', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});
