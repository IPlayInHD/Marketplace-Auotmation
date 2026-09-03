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

export interface WebConfig {
  appEnv: AppEnvironment;
  databaseUrl: string;
  host: string;
  port: number;
  logLevel: z.infer<typeof WebConfigSchema>['LOG_LEVEL'];
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

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
