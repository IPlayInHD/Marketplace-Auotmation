import { describe, expect, it } from 'vitest';
import * as auth from '../../src/modules/identity-auth/index.ts';

// D-19 conditions 1 and 2 (unit): Argon2id known-answer vectors of the reference implementation,
// PHC encoding and bounded decoding, needsRehash, the decoy path and the startup capability check.

// P-H-C/phc-winner-argon2 src/test.c, Argon2_id branch: hashtest(version, t, log2(m), p, pw, salt, hex, encoded).
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

describe('Argon2id password verifiers (AUTH-201, D-19)', () => {
  it('reproduce the reference implementation known-answer vectors, raw and PHC-encoded', async () => {
    for (const v of REFERENCE_VECTORS) {
      const params = { memory: v.memory, passes: v.passes, parallelism: v.parallelism, tagLength: 32 };
      const tag = await auth.deriveArgon2id(Buffer.from(v.password), Buffer.from(v.salt), params);
      expect(tag.toString('hex')).toBe(v.hex);
      expect(auth.encodeVerifier(params, Buffer.from(v.salt), tag)).toBe(v.encoded);
      expect(await auth.verifyPassword(v.encoded, v.password)).toBe(true);
      expect(await auth.verifyPassword(v.encoded, `${v.password}x`)).toBe(false);
    }
  });

  it('hash with the policy parameters and a fresh 16-byte salt, and verify only the right password', async () => {
    const a = await auth.hashPassword('correct horse battery staple');
    const b = await auth.hashPassword('correct horse battery staple');
    expect(a).not.toBe(b);
    for (const phc of [a, b]) {
      expect(
        phc.startsWith(
          `$argon2id$v=19$m=${auth.ARGON2_POLICY.memory},t=${auth.ARGON2_POLICY.passes},p=${auth.ARGON2_POLICY.parallelism}$`,
        ),
      ).toBe(true);
      const decoded = auth.decodeVerifier(phc);
      expect(decoded?.salt.length).toBe(auth.ARGON2_POLICY.saltLength);
      expect(decoded?.tag.length).toBe(auth.ARGON2_POLICY.tagLength);
      expect(auth.needsRehash(phc)).toBe(false);
      expect(await auth.verifyPassword(phc, 'correct horse battery staple')).toBe(true);
      expect(await auth.verifyPassword(phc, 'correct horse battery stapl')).toBe(false);
      expect(await auth.verifyPassword(phc, '')).toBe(false);
    }
    expect(auth.ARGON2_POLICY.saltLength).toBeGreaterThanOrEqual(16);
    expect(a).not.toContain('correct horse');
  });

  it('refuse malformed, truncated, unsupported-version, resource-exhausting or non-argon2id verifiers without deriving', async () => {
    const good = await auth.hashPassword('another strong passphrase');
    const [, , , mtp, salt, tag] = good.split('$');
    const cases: [string, string][] = [
      ['empty', ''],
      ['plaintext', 'plaintext'],
      ['truncated', good.slice(0, -1)],
      ['argon2i', `$argon2i$v=19$${mtp}$${salt}$${tag}`],
      ['argon2d', `$argon2d$v=19$${mtp}$${salt}$${tag}`],
      ['version 16', `$argon2id$v=16$${mtp}$${salt}$${tag}`],
      ['version 20', `$argon2id$v=20$${mtp}$${salt}$${tag}`],
      ['memory 1 GiB', `$argon2id$v=19$m=1048576,t=2,p=1$${salt}$${tag}`],
      ['memory 9,999,999 KiB', `$argon2id$v=19$m=9999999,t=2,p=1$${salt}$${tag}`],
      ['passes 0', `$argon2id$v=19$m=19456,t=0,p=1$${salt}$${tag}`],
      ['passes 999', `$argon2id$v=19$m=19456,t=999,p=1$${salt}$${tag}`],
      ['lanes 64', `$argon2id$v=19$m=19456,t=2,p=64$${salt}$${tag}`],
      ['memory below 8 per lane', `$argon2id$v=19$m=8,t=2,p=2$${salt}$${tag}`],
      ['padded salt', `$argon2id$v=19$m=19456,t=2,p=1$${salt}=$${tag}`],
      ['trailing field', `$argon2id$v=19$${mtp}$${salt}$${tag}$extra`],
      ['oversized string', `$argon2id$v=19$m=19456,t=2,p=1$${salt}$${'A'.repeat(600)}`],
    ];
    for (const [label, phc] of cases) {
      expect(auth.decodeVerifier(phc), label).toBeNull();
      expect(await auth.verifyPassword(phc, 'another strong passphrase'), label).toBe(false);
      expect(auth.needsRehash(phc), label).toBe(true);
    }
    // In-bounds but off-policy: verifies, and asks for a rehash.
    const legacy = await auth.hashPassword('another strong passphrase', {
      memory: 4096,
      passes: 3,
      parallelism: 1,
      tagLength: 32,
    });
    expect(await auth.verifyPassword(legacy, 'another strong passphrase')).toBe(true);
    expect(auth.needsRehash(legacy)).toBe(true);
    expect(auth.ARGON2_LIMITS.memory).toBeLessThanOrEqual(1 << 18);
  });

  it('do the same key derivation for an unknown account and always answer false', async () => {
    const verifier = await auth.createPasswordVerifier();
    const started = process.hrtime.bigint();
    const answer = await verifier.verifyAgainstDecoy('whatever the attacker typed');
    const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
    expect(answer).toBe(false);
    // 19 MiB and 2 passes cost measurably more than a lookup; the decoy path is not a short-circuit.
    expect(elapsed).toBeGreaterThan(1);
  });

  it('enforce the password policy server-side and never echo the password in the error', () => {
    expect(() => auth.assertPasswordPolicy('short')).toThrow(auth.PasswordPolicyError);
    expect(() => auth.assertPasswordPolicy('x'.repeat(auth.PASSWORD_POLICY.maxLength + 1))).toThrow(
      auth.PasswordPolicyError,
    );
    expect(() => auth.assertPasswordPolicy(12345678901234)).toThrow(auth.PasswordPolicyError);
    expect(() => auth.assertPasswordPolicy('a'.repeat(auth.PASSWORD_POLICY.minLength))).not.toThrow();
    try {
      auth.assertPasswordPolicy('tooshortpw');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(auth.PasswordPolicyError);
      expect(String(err)).not.toContain('tooshortpw');
      expect(JSON.stringify(err)).not.toContain('tooshortpw');
    }
  });

  it('fail closed at startup without a working crypto.argon2 and accept no fallback (D-19 condition 1)', async () => {
    await expect(auth.assertArgon2Capability()).resolves.toBeUndefined();
    await expect(auth.assertArgon2Capability(null)).rejects.toThrow(auth.Argon2UnavailableError);
    await expect(auth.assertArgon2Capability('argon2')).rejects.toThrow(auth.Argon2UnavailableError);
    await expect(auth.assertArgon2Capability({})).rejects.toThrow(auth.Argon2UnavailableError);
    const wrongTag = (_a: string, _p: unknown, cb: (e: null, b: Buffer) => void) =>
      cb(null, Buffer.alloc(32));
    await expect(auth.assertArgon2Capability(wrongTag)).rejects.toThrow(/reference vector/);
    const throwing = (_a: string, _p: unknown, cb: (e: Error) => void) => cb(new Error('no argon2'));
    await expect(auth.assertArgon2Capability(throwing)).rejects.toThrow(/self-test/);
  });
});
