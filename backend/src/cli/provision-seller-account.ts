import { randomUUID } from 'node:crypto';
import { AppEnvironment, loadMigrationConfig } from '../config.ts';
import { createDb } from '../db/kysely.ts';
import * as auth from '../modules/identity-auth/index.ts';
import * as sellers from '../modules/sellers/index.ts';

// Founder-controlled synthetic account provisioning (D-18, D-19 condition 7). An explicit
// operator action run as the migration role, never a route and never the runtime role, which
// cannot create an account. Open registration does not exist.
//
//   MIGRATION_DATABASE_URL   connection string for app_migrator
//   APP_ENV                  refused when production
//   stdin                    one JSON object: {"displayName": "...", "email": "...", "password": "..."}
//
// The password arrives on stdin only: never as an argument, never in a file this tool reads,
// never printed. The output names the created identifiers and nothing else.

process.stderr.write(
  'provision-seller-account: creates ONE founder-controlled synthetic account (D-18). Open registration does not exist.\n',
);

const config = loadMigrationConfig(process.env);
const environment = AppEnvironment.parse(process.env['APP_ENV'] ?? 'local');
const raw = await new Promise<string>((resolve, reject) => {
  let text = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    text += chunk;
    if (text.length > 4096) reject(new Error('input too large'));
  });
  process.stdin.on('end', () => resolve(text));
  process.stdin.on('error', reject);
});

let input: unknown;
try {
  input = JSON.parse(raw);
} catch {
  process.stderr.write('provision-seller-account: stdin must hold one JSON object\n');
  process.exit(2);
}

const handle = createDb(config.migrationDatabaseUrl, { applicationName: 'marketplace-provision', max: 1 });
try {
  await auth.assertArgon2Capability();
  const passwords = await auth.createPasswordVerifier();
  const created = await auth.provisionSyntheticAccount(
    handle.db,
    passwords,
    environment,
    auth.ProvisionInputSchema.parse(input),
    async (db, displayName, requestId) => sellers.createSeller(db, { displayName, requestId }),
    `provision-${randomUUID()}`,
  );
  process.stdout.write(`${JSON.stringify({ seller_id: created.sellerId, account_id: created.accountId })}\n`);
} catch (err) {
  // The reason only; never the input.
  const code = err instanceof Error && 'code' in err ? String((err as { code: unknown }).code) : 'error';
  process.stderr.write(`provision-seller-account: failed (${code})\n`);
  process.exitCode = 1;
} finally {
  await handle.close();
}
