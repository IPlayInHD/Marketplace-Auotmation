import pino, { type DestinationStream, type Logger } from 'pino';

// Structured logging (OPS-563, OPS-572, OPS-573) with the prohibitions of OPS-564 to OPS-570.
// Redaction is a backstop: call sites pass typed, allowlisted fields; if a forbidden key still
// reaches the logger (for example a whole record passed by mistake) the value is removed before
// serialisation.

/** Keys that must never appear in a log record at any depth. */
export const FORBIDDEN_LOG_KEYS = [
  'password',
  'passwordHash',
  'password_hash',
  'accessCode',
  'access_code',
  'plaintextCode',
  'plaintext_code',
  'code',
  'codeHash',
  'code_hash',
  'sessionToken',
  'session_token',
  'token',
  'secret',
  'apiKey',
  'api_key',
  'authorization',
  'cookie',
  'connectionString',
  'databaseUrl',
  'minimumPrice',
  'minimum_price',
  'minimumPriceMinor',
  'minimum_price_minor',
  'maxAutonomousConcession',
  'max_autonomous_concession_minor',
  'acquisitionCost',
  'acquisition_cost_minor',
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
  env: string;
  release: string;
  level?: string;
  /** Test hook: capture output instead of writing to stdout. */
  stream?: DestinationStream;
}

export function createLogger(options: LoggerOptions): Logger {
  const pinoOptions: pino.LoggerOptions = {
    level: options.level ?? 'info',
    base: { module: options.module, env: options.env, release: options.release },
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
    if (err.name === 'ZodError' || err.name === 'ValidationError') {
      return { error_category: 'validation', error_type: err.name };
    }
    if (typeof code === 'string' && /^(08|40|53|57P)/.test(code)) {
      // PostgreSQL connection, transaction-rollback (serialization/deadlock), resource and
      // operator-intervention classes are retryable.
      return { error_category: 'transient', error_type: `pg:${code}` };
    }
    return { error_category: 'permanent', error_type: err.name };
  }
  return { error_category: 'unknown', error_type: typeof err };
}
