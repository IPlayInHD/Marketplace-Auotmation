// AUTH-204 progressive delay (D-19 condition 6). State lives in auth.sign_in_throttle and time is
// the database's; this file holds the policy and its documentation (migration 0008).
//
// Only completed authentication failures count, per hashed account identifier and per hashed
// client identifier. Capacity is still reserved under a row lock before any credential work, so
// parallel attempts cannot all slip past the limit: an admitted attempt is "in flight" until the
// outcome finalizes it. An attempt is admitted while the failures plus the attempts in flight fit
// the free allowance; beyond it, attempts proceed one at a time, each after the lock the previous
// failure set: base * 2^(failures - free - 1) seconds, capped. An attempt refused while locked or
// while another is in flight answers a neutral 429 with Retry-After and changes nothing, so a
// flood cannot lock the owner out beyond the cap.
//
// Finalization: a failure adds exactly one failure and sets the lock its count earns. A success
// adds nothing; in the account scope it clears the account's failure history (the owner is back
// in), in the client scope it changes only the in-flight count, so successful sign-ins never
// throttle a shared network and one valid account can neither launder nor accelerate a client's
// failures against other accounts. Failure history decays after `decaySeconds` without a failure.
//
// Abandoned reservations (a process lost between reservation and finalization) count as in
// flight for at most `reservationSeconds` after the last admitted reservation on that subject,
// never become a failure, and are discarded by the next reservation after that window.
//
// Account scope: after failures 4, 5, 6, 7, 8 the next attempt waits 2, 4, 8, 16, 32 seconds;
// after every later failure 60. Client scope: after failure 11 onwards 2, 4, 8, ... up to 900.

export interface ThrottleScopePolicy {
  /** Completed failures admitted without delay. */
  freeFailures: number;
  baseSeconds: number;
  capSeconds: number;
  /** Failure history is forgotten after this long without a failure. */
  decaySeconds: number;
  /** How long an unfinalized reservation counts as in flight. */
  reservationSeconds: number;
}

export interface ThrottlePolicy {
  account: ThrottleScopePolicy;
  client: ThrottleScopePolicy;
}

export const THROTTLE_POLICY: ThrottlePolicy = {
  account: { freeFailures: 3, baseSeconds: 2, capSeconds: 60, decaySeconds: 3600, reservationSeconds: 60 },
  client: { freeFailures: 10, baseSeconds: 2, capSeconds: 900, decaySeconds: 3600, reservationSeconds: 60 },
};

/** The delay the policy imposes after `failures` completed failures, in seconds (0 while free). */
export function delayAfterFailures(policy: ThrottleScopePolicy, failures: number): number {
  if (failures <= policy.freeFailures) return 0;
  return Math.min(policy.capSeconds, policy.baseSeconds * 2 ** (failures - policy.freeFailures - 1));
}
