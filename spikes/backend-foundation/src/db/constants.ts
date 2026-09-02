// Names shared by the migration process, the runtime processes and the tests.
// Nothing here is a secret. Passwords are generated per run and never stored.

export const APP_SCHEMA = 'app';
export const PGBOSS_SCHEMA = 'pgboss';

export const ROLES = {
  /** Owns the application schema and the pg-boss schema. Runs migrations. Never used at runtime. */
  migrator: 'spike_migrator',
  /** Runtime role for the `web` entry point. */
  web: 'spike_web',
  /** Runtime role for the `worker` entry point. */
  worker: 'spike_worker',
} as const;

export type RoleName = (typeof ROLES)[keyof typeof ROLES];

/** The PostgreSQL setting that carries the transaction-scoped tenant context. */
export const TENANT_SETTING = 'app.seller_id';
