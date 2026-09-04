import pino, { type DestinationStream, type Logger } from 'pino';

// Structured logging with the prohibitions of OPS-567 (never a session token, a password or a
// reset token) as a redaction backstop; call sites pass allowlisted fields only.

export const FORBIDDEN_LOG_KEYS = [
  'password',
  'passwordHash',
  'password_hash',
  'verifier',
  'token',
  'sessionToken',
  'session_token',
  'tokenHash',
  'token_hash',
  'antiForgery',
  'anti_forgery',
  'x-anti-forgery',
  'cookie',
  'set-cookie',
  'authorization',
  'secret',
  'connectionString',
] as const;

function redactPaths(): string[] {
  const paths: string[] = [];
  for (const key of FORBIDDEN_LOG_KEYS) {
    const safe = key.includes('-') ? `["${key}"]` : key;
    paths.push(safe, `*.${safe}`, `*.*.${safe}`, `*.*.*.${safe}`);
  }
  return paths;
}

export function createLogger(options: { stream?: DestinationStream; level?: string } = {}): Logger {
  const pinoOptions: pino.LoggerOptions = {
    level: options.level ?? 'info',
    base: { module: 'authentication-spike' },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: redactPaths(), censor: '[REDACTED]' },
  };
  return options.stream ? pino(pinoOptions, options.stream) : pino(pinoOptions);
}
