import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// D-09, OPS-725, LIST-130 AC2, LIST-131: the seller types every price. No code path suggests,
// recommends, estimates or values anything. This scan keeps that true in identifiers, not only in
// prose: comments and string literals are stripped, and what remains must carry no such name.

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FORBIDDEN = /\b(suggest|recommend|estimat|valuat|apprais|comparable|forecast|predict)\w*/i;

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(full)));
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.sql')) files.push(full);
  }
  return files;
}

function codeOnly(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, '').replace(/--.*$/, ''))
    .join('\n');
}

describe('Pricing boundary (D-09, OPS-725)', () => {
  it('has no identifier in the source or the migrations that suggests, recommends, estimates or values a price', async () => {
    const files = await sourceFiles(path.join(backendRoot, 'src'));
    expect(files.length).toBeGreaterThan(20);
    const offenders: string[] = [];
    for (const file of files) {
      const code = codeOnly(await readFile(file, 'utf8'));
      const match = FORBIDDEN.exec(code);
      if (match) offenders.push(`${path.relative(backendRoot, file)}: ${match[0]}`);
    }
    expect(offenders).toEqual([]);
  });

  it('depends on no market-data, marketplace or model client', async () => {
    const manifest = JSON.parse(await readFile(path.join(backendRoot, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    const names = Object.keys(manifest.dependencies);
    expect(names.sort()).toEqual(['@fastify/cookie', 'fastify', 'kysely', 'pg', 'pino', 'zod']);
  });
});
