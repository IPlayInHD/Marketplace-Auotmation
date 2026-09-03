import { describe, expect, it } from 'vitest';
import { loadMigrationConfig, loadWebConfig } from '../../src/config.ts';

// D-18 private-alpha boundary at the process level: the web process binds to loopback unless an
// operator explicitly allows a network bind for an internal demonstration.

describe('Configuration', () => {
  it('defaults the web process to the loopback interface', () => {
    const config = loadWebConfig({ DATABASE_URL: 'postgresql://runtime@localhost/marketplace' });
    expect(config.host).toBe('127.0.0.1');
    expect(config.appEnv).toBe('local');
    expect(config.port).toBe(0);
  });

  it('refuses a non-loopback bind unless BACKEND_ALLOW_NETWORK_BIND=true', () => {
    expect(() => loadWebConfig({ DATABASE_URL: 'postgresql://x', HOST: '0.0.0.0' })).toThrow(/loopback/);
    expect(
      loadWebConfig({ DATABASE_URL: 'postgresql://x', HOST: '0.0.0.0', BACKEND_ALLOW_NETWORK_BIND: 'true' })
        .host,
    ).toBe('0.0.0.0');
  });

  it('requires the connection strings and accepts no default credential', () => {
    expect(() => loadWebConfig({})).toThrow();
    expect(() => loadMigrationConfig({})).toThrow();
    expect(loadMigrationConfig({ MIGRATION_DATABASE_URL: 'postgresql://m@localhost/db' })).toEqual({
      migrationDatabaseUrl: 'postgresql://m@localhost/db',
    });
  });

  it('rejects an unknown environment name', () => {
    expect(() => loadWebConfig({ DATABASE_URL: 'postgresql://x', APP_ENV: 'demo' })).toThrow();
  });
});
