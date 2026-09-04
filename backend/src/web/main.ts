import { loadWebConfig } from '../config.ts';
import { createDb } from '../db/kysely.ts';
import * as auth from '../modules/identity-auth/index.ts';
import { createLogger } from '../observability/logger.ts';
import { buildWebApp } from './app.ts';

// Web process entry point. Requires an already-migrated database reachable as the runtime role.
//   DATABASE_URL                 connection string for the app_runtime role
//   HOST, PORT                   bind address; loopback unless BACKEND_ALLOW_NETWORK_BIND=true (D-18)
//   APP_ENV, LOG_LEVEL           see src/config.ts
//   AUTH_*                       seller authentication (D-19); see src/config.ts and README

const config = loadWebConfig(process.env);
const logger = createLogger({
  module: 'web',
  env: config.appEnv,
  release: 'private-alpha',
  level: config.logLevel,
});
const handle = createDb(config.databaseUrl, { applicationName: 'marketplace-web' });
const passwords = await auth.createPasswordVerifier();
const app = await buildWebApp({
  db: handle.db,
  logger,
  appEnv: config.appEnv,
  authConfig: config.auth,
  passwords,
});

const address = await app.listen({ host: config.host, port: config.port });
logger.info({ address }, 'web listening');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void (async () => {
      await app.close();
      await handle.close();
      process.exit(0);
    })();
  });
}
