import { z } from 'zod';

// Runtime configuration is read from the environment at startup and validated once. Nothing here
// holds a default credential (OPS-729); the connection strings are supplied by the environment.
//
// Private alpha (D-18): the web process binds to the loopback interface unless an operator sets
// BACKEND_ALLOW_NETWORK_BIND=true for a founder-operated internal demonstration. No configuration
// exposes a public buyer page in this slice.

export const AppEnvironment = z.enum(['local', 'ci', 'staging', 'production']);
export type AppEnvironment = z.infer<typeof AppEnvironment>;

const WebConfigSchema = z.object({
  APP_ENV: AppEnvironment.default('local'),
  DATABASE_URL: z.string().min(1),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(0).max(65535).default(0),
  BACKEND_ALLOW_NETWORK_BIND: z.enum(['true', 'false']).default('false'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

/**
 * Seller authentication (D-19). The client-identifier key is a server-side secret delivered by
 * the environment or a secret store (OPS-729, INT-106); no hosting provider is chosen here. The
 * seller origin is the only origin state-changing seller requests may come from (SEC-311).
 */
const AuthConfigSchema = z.object({
  AUTH_SELLER_ORIGIN: z.string().min(1),
  AUTH_CLIENT_HASH_KEY: z
    .string()
    .regex(/^[0-9a-f]{64,128}$/, 'AUTH_CLIENT_HASH_KEY must be 32 to 64 bytes as lowercase hex'),
  AUTH_CLIENT_HASH_KEY_VERSION: z.coerce.number().int().min(1).max(32767).default(1),
  AUTH_TRUSTED_PROXIES: z.string().default(''),
  AUTH_SESSION_IDLE_SECONDS: z.coerce
    .number()
    .int()
    .min(60)
    .max(86_400)
    .default(12 * 60 * 60),
  AUTH_SESSION_ABSOLUTE_SECONDS: z.coerce
    .number()
    .int()
    .min(300)
    .max(90 * 86_400)
    .default(30 * 24 * 60 * 60),
});

export interface AuthConfig {
  /** Exactly an origin, e.g. https://seller.example. http is accepted on loopback in `local` only. */
  sellerOrigin: string;
  /** Raw key bytes for the keyed client and account identifier hashes (SEC-043). Never logged. */
  clientHashKey: Buffer;
  clientHashKeyVersion: number;
  /** IP addresses or CIDR ranges whose forwarding headers are believed. Empty: none. */
  trustedProxies: string[];
  sessionIdleSeconds: number;
  sessionAbsoluteSeconds: number;
}

export interface WebConfig {
  appEnv: AppEnvironment;
  databaseUrl: string;
  host: string;
  port: number;
  logLevel: z.infer<typeof WebConfigSchema>['LOG_LEVEL'];
  auth: AuthConfig;
}

export function loadAuthConfig(env: NodeJS.ProcessEnv, appEnv: AppEnvironment): AuthConfig {
  const parsed = AuthConfigSchema.parse(env);
  let origin: URL;
  try {
    origin = new URL(parsed.AUTH_SELLER_ORIGIN);
  } catch {
    throw new Error('AUTH_SELLER_ORIGIN is not a URL');
  }
  if (origin.origin !== parsed.AUTH_SELLER_ORIGIN)
    throw new Error('AUTH_SELLER_ORIGIN must be an origin, nothing more');
  if (origin.protocol !== 'https:') {
    if (appEnv !== 'local')
      throw new Error('AUTH_SELLER_ORIGIN must be https outside local development (AUTH-205)');
    if (!LOOPBACK_HOSTS.has(origin.hostname) && origin.hostname !== '[::1]') {
      throw new Error('an http AUTH_SELLER_ORIGIN is permitted on loopback only');
    }
  }
  const trustedProxies = parsed.AUTH_TRUSTED_PROXIES.split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return {
    sellerOrigin: origin.origin,
    clientHashKey: Buffer.from(parsed.AUTH_CLIENT_HASH_KEY, 'hex'),
    clientHashKeyVersion: parsed.AUTH_CLIENT_HASH_KEY_VERSION,
    trustedProxies,
    sessionIdleSeconds: parsed.AUTH_SESSION_IDLE_SECONDS,
    sessionAbsoluteSeconds: parsed.AUTH_SESSION_ABSOLUTE_SECONDS,
  };
}

export function loadWebConfig(env: NodeJS.ProcessEnv): WebConfig {
  const parsed = WebConfigSchema.parse(env);
  if (!LOOPBACK_HOSTS.has(parsed.HOST) && parsed.BACKEND_ALLOW_NETWORK_BIND !== 'true') {
    throw new Error(
      `HOST=${parsed.HOST} is not a loopback address; the private alpha binds to loopback unless BACKEND_ALLOW_NETWORK_BIND=true (D-18)`,
    );
  }
  return {
    appEnv: parsed.APP_ENV,
    databaseUrl: parsed.DATABASE_URL,
    host: parsed.HOST,
    port: parsed.PORT,
    logLevel: parsed.LOG_LEVEL,
    auth: loadAuthConfig(env, parsed.APP_ENV),
  };
}

const MigrationConfigSchema = z.object({
  MIGRATION_DATABASE_URL: z.string().min(1),
});

export interface MigrationConfig {
  migrationDatabaseUrl: string;
}

export function loadMigrationConfig(env: NodeJS.ProcessEnv): MigrationConfig {
  const parsed = MigrationConfigSchema.parse(env);
  return { migrationDatabaseUrl: parsed.MIGRATION_DATABASE_URL };
}
