import { PgBoss } from 'pg-boss';
import { PGBOSS_SCHEMA } from '../db/constants.ts';

// Runtime pg-boss configuration shared by the worker entry point and the web entry point's
// enqueue path. Every option that could cause schema changes is off:
//   migrate: false       start() only checks the installed schema version and throws if
//                        migrations are pending (docs/api/constructor.md "migrate");
//   createSchema: false  never issue CREATE SCHEMA;
//   reindex: false       never issue REINDEX; index maintenance is an operator task via
//                        getReindexCommands() (docs/api/ops.md);
//   schedule: false      no cron scheduler in the spike;
//   supervise: false     background maintenance is driven explicitly in tests via supervise();
//                        a production worker would enable it (it is DML-only under this role).

export interface RuntimeBossOptions {
  connectionString: string;
  applicationName: string;
  /** Test-only: enables pg-boss job spies for deterministic waits. */
  enableSpies?: boolean;
  /** Lower the monitor gate so tests can run supervise() more than once per minute. */
  monitorIntervalSeconds?: number;
  supervise?: boolean;
}

export function createRuntimeBoss(options: RuntimeBossOptions): PgBoss {
  return new PgBoss({
    connectionString: options.connectionString,
    schema: PGBOSS_SCHEMA,
    application_name: options.applicationName,
    max: 4,
    migrate: false,
    createSchema: false,
    reindex: false,
    schedule: false,
    supervise: options.supervise ?? false,
    ...(options.enableSpies ? { __test__enableSpies: true } : {}),
    ...(options.monitorIntervalSeconds !== undefined ? { monitorIntervalSeconds: options.monitorIntervalSeconds } : {}),
  });
}
