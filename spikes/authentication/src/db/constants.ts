// Names shared with the production schema (backend/src/db/constants.ts). Nothing here is a secret.

export const APP_SCHEMA = 'app';
/** Spike-only schema for the authentication tables. Never a production migration. */
export const AUTH_SCHEMA = 'auth';

export const ROLES = {
  migrator: 'app_migrator',
  runtime: 'app_runtime',
} as const;

/** The transaction-scoped tenant context setting read by app.current_seller_id() (SEC-101). */
export const TENANT_SETTING = 'app.seller_id';
