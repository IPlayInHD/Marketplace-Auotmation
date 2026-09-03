import { describe, expect, it } from 'vitest';
import { assertAuditSummaryIsSafe } from '../../src/modules/audit/index.ts';
import { ValidationError } from '../../src/shared/errors.ts';

// OPS-783, OPS-569, SEC-040: an audit payload carries no protected value, credential or code.

describe('Audit summary safety', () => {
  it('accepts lifecycle summaries', () => {
    expect(() => assertAuditSummaryIsSafe({ from: 'DRAFT', to: 'READY', row_version: 5 })).not.toThrow();
    expect(() => assertAuditSummaryIsSafe({ policy_version_number: 2 })).not.toThrow();
  });

  it('rejects protected, credential and personal-data keys at any depth', () => {
    for (const bad of [
      { minimum_price_minor: 20000 },
      { nested: { access_code: '123456' } },
      { auto_decline_threshold_minor: 1 },
      { session_token: 'x' },
      { buyer: { email: 'x' } },
      { internal_note: 'x' },
    ]) {
      expect(() => assertAuditSummaryIsSafe(bad)).toThrow(ValidationError);
    }
  });
});
