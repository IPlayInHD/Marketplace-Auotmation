import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FIXTURE } from '../helpers/fixtures.ts';

// DATA-110, OPS-500, D-18: fixtures and test data carry no real seller or buyer data. This scan
// runs over every source and test file so a real contact route cannot enter the repository unseen.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'coverage' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (/\.(ts|sql|cjs|js|json)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/;
const PHONE = /(?<![\w-])(\+?\d{1,3}[ .-])?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}(?![\w-])/;
const STREET_ADDRESS = /\b\d{1,5}\s+[A-Z][a-z]+\s+(Street|St\.|Avenue|Ave\.|Road|Rd\.|Boulevard|Blvd\.)\b/;

describe('Synthetic fixtures', () => {
  it('use fictional seller names and items only', () => {
    for (const name of Object.values(FIXTURE.sellers)) expect(name).toMatch(/^Fixture Seller [A-Z]$/);
    for (const value of Object.values(FIXTURE.facts)) expect(value).not.toMatch(EMAIL);
    expect(FIXTURE.facts.name).toMatch(/^Synthetic /);
    expect(FIXTURE.facts.brand).toMatch(/^Fictional /);
    expect(FIXTURE.copy.title).toContain('Synthetic');
  });

  it('contain no email address, phone number or street address anywhere under src/ or test/', async () => {
    const files = [...(await walk(path.join(root, 'src'))), ...(await walk(path.join(root, 'test')))];
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      const text = await readFile(file, 'utf8');
      expect(text, `${path.relative(root, file)} contains an email-like string`).not.toMatch(EMAIL);
      expect(text, `${path.relative(root, file)} contains a phone-like string`).not.toMatch(PHONE);
      expect(text, `${path.relative(root, file)} contains a street-address-like string`).not.toMatch(
        STREET_ADDRESS,
      );
    }
  });
});
