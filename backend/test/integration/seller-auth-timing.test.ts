import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { provisionAccount, signInRequest, startAuthApp, type AuthApp } from '../helpers/auth.ts';
import { startDatabase, type TestDatabase } from '../helpers/database.ts';

// AUTH-203 timing-distribution gate (D-19 condition 6). Two failure paths, unknown account and
// known account with a wrong password, do the same database work and one Argon2id derivation
// each. This test measures the two response-time distributions and refuses a material
// difference; a structural assertion proves each path ran exactly one equivalent derivation.
//
// Method: 15 warm-up requests per path, then SAMPLES per path taken interleaved (A, B, A, B, ...)
// so drift affects both equally. Statistics reported: median, p90, the Hodges-Lehmann shift
// (median of all pairwise differences) and the common-language effect size CLES = P(A < B).
// Acceptance: |shift| <= max(2 ms, 15% of the smaller median) and 0.35 <= CLES <= 0.65. With
// SAMPLES = 120 the standard error of CLES under no difference is about 0.053, so the bounds sit
// at 2.8 standard errors (roughly a 0.5% false-failure rate); a path that skipped the derivation
// (about 10 ms at 19 MiB and 2 passes) would move CLES to about 1.0 and fail decisively.
// The test never skips: CI runs it in the same mode as every other integration test.

const DOMAIN = 'synthetic.invalid';
const address = (local: string) => [local, DOMAIN].join('@');
const PASSWORD = 'synthetic passphrase for timing';
const WARM_UP = 15;
const SAMPLES = 120;

function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo] ?? 0;
  const b = sorted[hi] ?? a;
  return a + (b - a) * (pos - lo);
}

function hodgesLehmann(a: number[], b: number[]): number {
  const diffs: number[] = [];
  for (const x of a) for (const y of b) diffs.push(x - y);
  diffs.sort((p, q) => p - q);
  return quantile(diffs, 0.5);
}

/** P(A < B) + 0.5 P(A = B): 0.5 means no stochastic difference. */
function cles(a: number[], b: number[]): number {
  let wins = 0;
  for (const x of a) for (const y of b) wins += x < y ? 1 : x === y ? 0.5 : 0;
  return wins / (a.length * b.length);
}

describe('AUTH-203 timing distribution: unknown account versus wrong password', () => {
  let env: TestDatabase;
  let harness: AuthApp;
  const knownEmail = address('seller-timing');
  const unknownEmail = address('nobody-timing');

  beforeAll(async () => {
    env = await startDatabase();
    await provisionAccount(env, {
      displayName: 'Synthetic Seller Timing',
      email: knownEmail,
      password: PASSWORD,
    });
    harness = await startAuthApp(env, { poolMax: 2 });
  });
  afterAll(async () => {
    await harness?.close();
    await env?.stop();
  });

  it('shows no material difference between the two failure paths, each running exactly one derivation', async () => {
    const timed = async (email: string): Promise<number> => {
      const started = process.hrtime.bigint();
      const res = await signInRequest(harness, email, 'not the password anyway');
      const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
      expect(res.statusCode).toBe(401);
      return elapsed;
    };
    for (let i = 0; i < WARM_UP; i += 1) {
      await timed(unknownEmail);
      await timed(knownEmail);
    }
    const before = { ...harness.verifyCalls };
    const unknown: number[] = [];
    const wrong: number[] = [];
    for (let i = 0; i < SAMPLES; i += 1) {
      if (i % 2 === 0) {
        unknown.push(await timed(unknownEmail));
        wrong.push(await timed(knownEmail));
      } else {
        wrong.push(await timed(knownEmail));
        unknown.push(await timed(unknownEmail));
      }
    }
    // Structural gate: one decoy derivation per unknown-account request, one real per wrong-password request.
    expect(harness.verifyCalls.decoy - before.decoy).toBe(SAMPLES);
    expect(harness.verifyCalls.real - before.real).toBe(SAMPLES);

    const su = [...unknown].sort((a, b) => a - b);
    const sw = [...wrong].sort((a, b) => a - b);
    const stats = {
      samples_per_path: SAMPLES,
      unknown_account_ms: {
        median: quantile(su, 0.5),
        p90: quantile(su, 0.9),
        min: su[0],
        max: su[su.length - 1],
      },
      wrong_password_ms: {
        median: quantile(sw, 0.5),
        p90: quantile(sw, 0.9),
        min: sw[0],
        max: sw[sw.length - 1],
      },
      hodges_lehmann_shift_ms: hodgesLehmann(unknown, wrong),
      cles_unknown_faster: cles(unknown, wrong),
    };
    process.stdout.write(`AUTH-203 timing observations: ${JSON.stringify(stats)}\n`);
    const smallerMedian = Math.min(stats.unknown_account_ms.median, stats.wrong_password_ms.median);
    const tolerance = Math.max(2, 0.15 * smallerMedian);
    expect(
      Math.abs(stats.hodges_lehmann_shift_ms),
      `shift ${stats.hodges_lehmann_shift_ms} ms exceeds ${tolerance} ms`,
    ).toBeLessThanOrEqual(tolerance);
    expect(stats.cles_unknown_faster).toBeGreaterThanOrEqual(0.35);
    expect(stats.cles_unknown_faster).toBeLessThanOrEqual(0.65);
    // Both paths paid for the derivation: neither median is lookup-cheap.
    expect(smallerMedian).toBeGreaterThan(1);
  });
});
