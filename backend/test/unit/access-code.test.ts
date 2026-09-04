import { describe, expect, it } from 'vitest';
import {
  ACCESS_CODE_LENGTH,
  generateAccessCode,
  hashAccessCode,
  isWellFormedAccessCode,
  SCRYPT_PARAMS,
  verifyAccessCodeHash,
} from '../../src/modules/access-codes/index.ts';
import { ValidationError } from '../../src/shared/errors.ts';

// BUYER-008, OPS-710, DM-08 (unit): six digits with leading zeros kept, CSPRNG generation, and a
// salted slow-KDF hash that never contains or reveals the code.

const wrong = (code: string) => code.slice(0, 5) + String((Number(code[5]) + 1) % 10);

describe('Access code generation', () => {
  it('always yields exactly six digits and keeps leading zeros', () => {
    const codes = Array.from({ length: 3000 }, () => generateAccessCode());
    for (const code of codes) {
      expect(code).toMatch(/^[0-9]{6}$/);
      expect(code).toHaveLength(ACCESS_CODE_LENGTH);
      expect(isWellFormedAccessCode(code)).toBe(true);
    }
    expect(codes.some((c) => c.startsWith('0'))).toBe(true);
    expect(new Set(codes.map((c) => c[0])).size).toBe(10);
  });

  it('accepts only six-digit strings as well formed', () => {
    for (const bad of ['12345', '1234567', '12a456', ' 123456', 123456, null, undefined, '']) {
      expect(isWellFormedAccessCode(bad), String(bad)).toBe(false);
    }
    expect(isWellFormedAccessCode('000000')).toBe(true);
  });
});

describe('Access code hashing', () => {
  it('stores a self-describing salted scrypt hash that verifies the code and nothing else', async () => {
    const code = generateAccessCode();
    const stored = await hashAccessCode(code);
    expect(stored).toMatch(/^\$scrypt\$ln=14,r=8,p=1\$[A-Za-z0-9+/]+={0,2}\$[A-Za-z0-9+/]+={0,2}$/);
    expect(SCRYPT_PARAMS.ln).toBeGreaterThanOrEqual(14);
    expect(stored).not.toContain(code);
    expect(await verifyAccessCodeHash(code, stored)).toBe(true);
    expect(await verifyAccessCodeHash(wrong(code), stored)).toBe(false);
    expect(await verifyAccessCodeHash(code.slice(1), stored)).toBe(false);
    expect(await verifyAccessCodeHash(`${code}0`, stored)).toBe(false);
  });

  it('salts every hash, so the same code never hashes the same way twice', async () => {
    const code = '000123';
    const [a, b] = await Promise.all([hashAccessCode(code), hashAccessCode(code)]);
    expect(a).not.toBe(b);
    expect(await verifyAccessCodeHash(code, a)).toBe(true);
    expect(await verifyAccessCodeHash(code, b)).toBe(true);
  });

  it('refuses to hash a malformed code and answers false, not an error, for malformed input or storage', async () => {
    await expect(hashAccessCode('12345')).rejects.toBeInstanceOf(ValidationError);
    await expect(hashAccessCode('abcdef')).rejects.toBeInstanceOf(ValidationError);
    const stored = await hashAccessCode('123456');
    expect(await verifyAccessCodeHash(123456, stored)).toBe(false);
    expect(await verifyAccessCodeHash('123456', 'not-a-hash')).toBe(false);
    expect(await verifyAccessCodeHash('123456', '')).toBe(false);
  });
});
