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
  'copyBlock',
  'copy_block',
  'code',
  'codeHash',
  'code_hash',
  'sessionToken',
  'session_token',
  'token',
  'tokenHash',
  'token_hash',
  'antiForgery',
  'anti_forgery',
  'x-anti-forgery',
  'set-cookie',
  'email',
  'emailNormalized',
  'email_normalized',
  'ip',
  'remoteAddress',
  'remote_address',
  'x-forwarded-for',
  'forwarded',
  'x-real-ip',
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
    // pino path syntax: a key with a hyphen must be bracketed.
    const safe = key.includes('-') ? `["${key}"]` : key;
    paths.push(safe, `*.${safe}`, `*.*.${safe}`, `*.*.*.${safe}`);
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

const LOGGED_PATH_MAX = 2048;

/**
 * The request target as it may be logged (OPS-563, OPS-567, DATA_AND_PRIVACY §2: logs are P1 and
 * hold no P2 to P4 content): the path only. Everything from the first `?` or `#` on is dropped,
 * generically, so no query string, pagination cursor, filter, page size or stray parameter reaches
 * a log line; an absolute-form target loses its scheme and authority; anything that is not a
 * string becomes the empty string. The result is bounded and the function never throws.
 */
export function sanitizeRequestUrl(url: unknown): string {
  if (typeof url !== 'string') return '';
  let end = url.length;
  for (const delimiter of ['?', '#']) {
    const at = url.indexOf(delimiter);
    if (at >= 0 && at < end) end = at;
  }
  let path = url.slice(0, end);
  const absolute = /^[a-z][a-z0-9+.-]*:\/\/[^/]*/i.exec(path);
  if (absolute) path = path.slice(absolute[0].length) || '/';
  return path.length > LOGGED_PATH_MAX ? path.slice(0, LOGGED_PATH_MAX) : path;
}

export interface LoggedRequest {
  method?: string;
  /** The sanitized path: never a query string. */
  url: string;
  /** The matched route template, when the router matched one. */
  route?: string;
}

/**
 * The `req` serializer installed on every logger this module creates. Fastify merges a logger
 * instance's own serializers over its defaults, so this replaces the default request line (raw
 * URL, host, client address) with the method, the sanitized path and the route template; headers,
 * cookies, the client address and the query never enter the record. Total: never throws.
 */
/** A property read that cannot throw: a request exposes getters, and a getter may fail early in a request's life. */
function readProperty(source: unknown, key: string): unknown {
  if (typeof source !== 'object' || source === null) return undefined;
  try {
    return (source as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

export function serializeRequest(req: unknown): LoggedRequest {
  const method = readProperty(req, 'method');
  const route = readProperty(readProperty(req, 'routeOptions'), 'url');
  const logged: LoggedRequest = { url: sanitizeRequestUrl(readProperty(req, 'url')) };
  if (typeof method === 'string') logged.method = method;
  if (typeof route === 'string') logged.route = route;
  return logged;
}

export function createLogger(options: LoggerOptions): Logger {
  const pinoOptions: pino.LoggerOptions = {
    level: options.level ?? 'info',
    base: { module: options.module, env: options.env, release: options.release },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ severity: label }) },
    redact: { paths: redactPaths(), censor: '[REDACTED]' },
    serializers: { req: serializeRequest },
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
