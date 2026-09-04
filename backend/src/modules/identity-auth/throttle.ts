// AUTH-204 progressive delay (D-19 condition 6). State lives in auth.sign_in_throttle and time is
// the database's; this file holds the policy and its documentation.
//
// Every sign-in attempt is counted under a row lock before any credential work, per hashed
// account identifier and per hashed client identifier. Once a scope's attempts exceed its free
// allowance, the next attempt may start only after a delay of base * 2^(attempts - free - 1)
// seconds, capped. An attempt made while locked is refused with a neutral response and Retry-After
// and does not extend the lock, so a flood cannot lock the owner out beyond the cap. A scope's
// counter decays to zero after `decaySeconds` without attempts. A successful sign-in clears the
// account counter (the owner is back in); client counters decay with time only, so one valid
// account cannot be used to reset a client's limit.
//
// Account scope: attempts 4, 5, 6, 7, 8 wait 2, 4, 8, 16, 32 seconds; every later attempt 60.
// Client scope: attempts 11 onwards wait 2, 4, 8, ... seconds up to 900.

export interface ThrottleScopePolicy {
  freeAttempts: number;
  baseSeconds: number;
  capSeconds: number;
  decaySeconds: number;
}

export interface ThrottlePolicy {
  account: ThrottleScopePolicy;
  client: ThrottleScopePolicy;
}

export const THROTTLE_POLICY: ThrottlePolicy = {
  account: { freeAttempts: 3, baseSeconds: 2, capSeconds: 60, decaySeconds: 3600 },
  client: { freeAttempts: 10, baseSeconds: 2, capSeconds: 900, decaySeconds: 3600 },
};

/** The delay the policy imposes after `attempts` counted attempts, in seconds (0 while free). */
export function delayAfterAttempts(policy: ThrottleScopePolicy, attempts: number): number {
  if (attempts <= policy.freeAttempts) return 0;
  return Math.min(policy.capSeconds, policy.baseSeconds * 2 ** (attempts - policy.freeAttempts - 1));
}
