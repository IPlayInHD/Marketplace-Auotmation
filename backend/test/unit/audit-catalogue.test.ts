import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AUDIT_EVENT_TYPES } from '../../src/db/schema.ts';

// OPS-781: the canonical catalogue (ai/POLICY_AND_AUTHORIZATION.md §12), the TypeScript event
// list and the migrations' enum values name exactly the same events. The database enum itself is
// compared in test/integration/migrations.test.ts.

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const catalogue = path.resolve(backendRoot, '..', 'docs', 'ai', 'POLICY_AND_AUTHORIZATION.md');

async function catalogueEvents(): Promise<string[]> {
  const text = await readFile(catalogue, 'utf8');
  const start = text.indexOf('## 12. Required audit events');
  expect(start).toBeGreaterThan(0);
  const rest = text.slice(start + 1);
  const end = rest.search(/\n## /);
  const section = end === -1 ? rest : rest.slice(0, end);
  const names = [...section.matchAll(/`([A-Z][A-Z_]+)`/g)].map((m) => m[1] ?? '');
  return [...new Set(names.filter((n) => /^[A-Z_]+$/.test(n) && n.includes('_')))].sort();
}

async function migrationEnumEvents(): Promise<string[]> {
  const dir = path.join(backendRoot, 'src', 'db', 'migrations');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const values = new Set<string>();
  for (const file of files) {
    const sql = await readFile(path.join(dir, file), 'utf8');
    const create = /CREATE TYPE app\.audit_event_type AS ENUM \(([\s\S]*?)\);/.exec(sql);
    if (create) {
      for (const m of create[1]?.matchAll(/'([A-Z_]+)'/g) ?? []) values.add(m[1] ?? '');
    }
    for (const m of sql.matchAll(
      /ALTER TYPE app\.audit_event_type ADD VALUE(?: IF NOT EXISTS)? '([A-Z_]+)'/g,
    )) {
      values.add(m[1] ?? '');
    }
  }
  return [...values].sort();
}

describe('Audit event catalogue', () => {
  it('names the two listing events introduced to complete OPS-781', async () => {
    const names = await catalogueEvents();
    expect(names).toContain('LISTING_STATUS_CHANGED');
    expect(names).toContain('LISTING_ASKING_PRICE_CHANGED');
    expect(names).toContain('ACCESS_CODE_EXPIRED');
    for (const name of [
      'SELLER_SIGN_IN_SUCCEEDED',
      'SELLER_SIGN_IN_FAILED',
      'SELLER_SIGN_IN_THROTTLED',
      'SELLER_SESSION_ROTATED',
      'SELLER_SIGNED_OUT',
      'SELLER_SESSIONS_REVOKED',
      'SELLER_SESSION_EVICTED',
    ]) {
      expect(names, name).toContain(name);
    }
  });

  it('is identical in the canonical document, the TypeScript list and the migrations', async () => {
    const doc = await catalogueEvents();
    const code = [...AUDIT_EVENT_TYPES].sort();
    const sql = await migrationEnumEvents();
    expect(code).toEqual(doc);
    expect(sql).toEqual(doc);
    // The catalogue's own exclusions never appear as event names.
    expect(doc).not.toContain('MINIMUM_PRICE');
    expect(doc.length).toBeGreaterThanOrEqual(25);
  });
});
