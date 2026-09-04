import { describe, expect, it } from 'vitest';
import { ARGON2_POLICY, PASSWORD_POLICY } from '../src/config.ts';
import {
  assertPasswordPolicy,
  createPasswordVerifier,
  decodeVerifier,
  deriveArgon2id,
  encodeVerifier,
  hashPassword,
  needsRehash,
  PasswordPolicyError,
  verifyPassword,
} from '../src/password.ts';

// Proof 1 (Argon2id creation and verification), proof 2 (unknown-account work), proof 13
// (no leakage in errors), proof 14 (Node 24 + strict TypeScript: this file type-checks).

// Known-answer vectors from the Argon2 reference implementation, P-H-C/phc-winner-argon2
// src/test.c (hashtest(version, t, log2(m), p, password, salt, hex, encoded), Argon2_id branch).
const REFERENCE_VECTORS = [
  {
    passes: 2,
    memory: 65_536,
    parallelism: 1,
    password: 'password',
    salt: 'somesalt',
    hex: '09316115d5cf24ed5a15a31a3ba326e5cf32edc24702987c02b6566f61913cf7',
    encoded: '$argon2id$v=19$m=65536,t=2,p=1$c29tZXNhbHQ$CTFhFdXPJO1aFaMaO6Mm5c8y7cJHAph8ArZWb2GRPPc',
  },
  {
    passes: 2,
    memory: 256,
    parallelism: 1,
    password: 'password',
    salt: 'somesalt',
    hex: '9dfeb910e80bad0311fee20f9c0e2b12c17987b4cac90c2ef54d5b3021c68bfe',
    encoded: '$argon2id$v=19$m=256,t=2,p=1$c29tZXNhbHQ$nf65EOgLrQMR/uIPnA4rEsF5h7TKyQwu9U1bMCHGi/4',
  },
  {
    passes: 2,
    memory: 256,
    parallelism: 2,
    password: 'password',
    salt: 'somesalt',
    hex: '6d093c501fd5999645e0ea3bf620d7b8be7fd2db59c20d9fff9539da2bf57037',
    encoded: '$argon2id$v=19$m=256,t=2,p=2$c29tZXNhbHQ$bQk8UB/VmZZF4Oo79iDXuL5/0ttZwg2f/5U52iv1cDc',
  },
  {
    passes: 2,
    memory: 65_536,
    parallelism: 1,
    password: 'password',
    salt: 'diffsalt',
    hex: 'bdf32b05ccc42eb15d58fd19b1f856b113da1e9a5874fdcc544308565aa8141c',
    encoded: '$argon2id$v=19$m=65536,t=2,p=1$ZGlmZnNhbHQ$vfMrBczELrFdWP0ZsfhWsRPaHppYdP3MVEMIVlqoFBw',
  },
] as const;

describe('Argon2id from node:crypto', () => {
  it('reproduces the reference implementation known-answer vectors, raw and PHC-encoded', async () => {
    for (const v of REFERENCE_VECTORS) {
      const params = { memory: v.memory, passes: v.passes, parallelism: v.parallelism, tagLength: 32 };
      const tag = await deriveArgon2id(Buffer.from(v.password), Buffer.from(v.salt), params);
      expect(tag.toString('hex')).toBe(v.hex);
      expect(encodeVerifier(params, Buffer.from(v.salt), tag)).toBe(v.encoded);
      expect(await verifyPassword(v.encoded, v.password)).toBe(true);
      expect(await verifyPassword(v.encoded, `${v.password}x`)).toBe(false);
    }
  });

  it('hashes with the policy parameters, a fresh 16-byte salt each time, and verifies only the right password', async () => {
    const a = await hashPassword('correct horse battery staple');
    const b = await hashPassword('correct horse battery staple');
    expect(a).not.toBe(b);
    for (const phc of [a, b]) {
      expect(
        phc.startsWith(
          `$argon2id$v=19$m=${ARGON2_POLICY.memory},t=${ARGON2_POLICY.passes},p=${ARGON2_POLICY.parallelism}$`,
        ),
      ).toBe(true);
      const decoded = decodeVerifier(phc);
      expect(decoded?.salt.length).toBe(ARGON2_POLICY.saltLength);
      expect(decoded?.tag.length).toBe(ARGON2_POLICY.tagLength);
      expect(needsRehash(phc)).toBe(false);
      expect(await verifyPassword(phc, 'correct horse battery staple')).toBe(true);
      expect(await verifyPassword(phc, 'correct horse battery stapl')).toBe(false);
      expect(await verifyPassword(phc, '')).toBe(false);
    }
    expect(a).not.toContain('correct horse');
  });

  it('refuses malformed, truncated, out-of-bounds or non-argon2id verifiers without deriving', async () => {
    const good = await hashPassword('another strong passphrase');
    const [, , , mtp, salt, tag] = good.split('$');
    const cases = [
      '',
      'plaintext',
      good.slice(0, -1),
      `$argon2i$v=19$${mtp}$${salt}$${tag}`,
      `$argon2id$v=16$${mtp}$${salt}$${tag}`,
      `$argon2id$v=19$m=8388608,t=2,p=1$${salt}$${tag}`,
      `$argon2id$v=19$m=19456,t=0,p=1$${salt}$${tag}`,
      `$argon2id$v=19$m=19456,t=2,p=1$${salt}=$${tag}`,
      `$argon2id$v=19$${mtp}$${salt}$${tag}$extra`,
    ];
    for (const phc of cases) {
      expect(decodeVerifier(phc), phc).toBeNull();
      expect(await verifyPassword(phc, 'another strong passphrase')).toBe(false);
      expect(needsRehash(phc)).toBe(true);
    }
    expect(needsRehash(`$argon2id$v=19$m=65536,t=2,p=1$${salt}$${tag}`)).toBe(true);
  });

  it('does the same key derivation for an unknown account and always answers false', async () => {
    const verifier = await createPasswordVerifier();
    const started = process.hrtime.bigint();
    const answer = await verifier.verifyAgainstNothing('whatever the attacker typed');
    const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
    expect(answer).toBe(false);
    // 19 MiB, 2 passes: measurably more than a lookup. Not a timing-distribution test (AUTH-203
    // production obligation); it shows the decoy path is not a short-circuit.
    expect(elapsed).toBeGreaterThan(1);
  });

  it('enforces the password policy server-side and never echoes the password in the error', () => {
    expect(() => assertPasswordPolicy('short')).toThrow(PasswordPolicyError);
    expect(() => assertPasswordPolicy('x'.repeat(PASSWORD_POLICY.maxLength + 1))).toThrow(
      PasswordPolicyError,
    );
    expect(() => assertPasswordPolicy(12345678901234)).toThrow(PasswordPolicyError);
    expect(() => assertPasswordPolicy('a'.repeat(PASSWORD_POLICY.minLength))).not.toThrow();
    try {
      assertPasswordPolicy('tooshortpw');
    } catch (err) {
      expect(err).toBeInstanceOf(PasswordPolicyError);
      expect(String(err)).not.toContain('tooshortpw');
      expect(JSON.stringify(err)).not.toContain('tooshortpw');
    }
  });
});
