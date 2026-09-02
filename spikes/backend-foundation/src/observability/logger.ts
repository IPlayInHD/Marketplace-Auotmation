import pino, { type DestinationStream, type Logger } from 'pino';

// Structured logging (OPS-563, OPS-572, OPS-573, OPS-564 to OPS-570).
//
// Two layers:
//   1. Typed, allowlisted log-record shapes (RequestLogFields, JobLogFields) so call sites cannot
//      invent fields. This is the primary control.
//   2. pino redaction as a backstop: if a forbidden key still reaches the logger (for example a
//      whole record object passed by mistake) the value is removed before serialisation.

/** Keys that must never appear in a log record at any depth. */
export const FORBIDDEN_LOG_KEYS = [
  'password',
  'passwordHash',
  'password_hash',
  'accessCode',
  'access_code',
  'sessionToken',
  'session_token',
  'token',
  'secret',
  'apiKey',
  'api_key',
  'authorization',
  'cookie',
  'connectionString',
  'minimumPriceMinor',
  'minimum_price_minor',
  'internalNotes',
  'internal_notes',
] as const;

function redactPaths(): string[] {
  const paths: string[] = [];
  for (const key of FORBIDDEN_LOG_KEYS) {
    paths.push(key, `*.${key}`, `*.*.${key}`, `*.*.*.${key}`);
  }
  return paths;
}

export interface LoggerOptions {
  module: string;
  level?: string;
  /** Test hook: capture output instead of writing to stdout. */
  stream?: DestinationStream;
}

export function createLogger(options: LoggerOptions): Logger {
  const level = options.level ?? 'info';
  const pinoOptions: pino.LoggerOptions = {
    level,
    base: { module: options.module, env: 'spike', release: 'spike' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ severity: label }) },
    redact: { paths: redactPaths(), censor: '[REDACTED]' },
  };
  return options.stream ? pino(pinoOptions, options.stream) : pino(pinoOptions);
}

export type ErrorCategory = 'transient' | 'permanent' | 'validation' | 'unknown';

/** Classifies an error without interpolating any data into the log message (OPS-573). */
export function categorizeError(err: unknown): { error_category: ErrorCategory; error_type: string } {
  if (err instanceof Error) {
    const code = (err as Error & { code?: unknown }).code;
    if (err.name === 'ZodError') return { error_category: 'validation', error_type: err.name };
    if (typeof code === 'string' && /^(08|40|53|57P)/.test(code)) {
      // PostgreSQL connection, transaction-rollback (serialization/deadlock), resource and
      // operator-intervention classes are retryable.
      return { error_category: 'transient', error_type: `pg:${code}` };
    }
    if (err.name === 'TransientError') return { error_category: 'transient', error_type: err.name };
    return { error_category: 'permanent', error_type: err.name };
  }
  return { error_category: 'unknown', error_type: typeof err };
}

/** The complete allowlist of job log fields. Nothing else is accepted by logJobOutcome. */
export interface JobLogFields {
  request_id?: string;
  job_id: string;
  job_name: string;
  job_attempt: number;
  seller_id?: string;
  outcome: 'completed' | 'failed' | 'skipped_duplicate';
  error_category?: ErrorCategory;
  error_type?: string;
  duration_ms?: number;
}

export function logJobOutcome(log: Logger, fields: JobLogFields): void {
  const { outcome, ...rest } = fields;
  const record: JobLogFields = { ...rest, outcome };
  if (outcome === 'failed') log.warn(record, 'job outcome');
  else log.info(record, 'job outcome');
}
