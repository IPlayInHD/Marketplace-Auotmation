import { describe, expect, it } from 'vitest';
import { loadAuthConfig, loadMigrationConfig, loadWebConfig } from '../../src/config.ts';

const AUTH_ENV = {
  AUTH_SELLER_ORIGIN: 'https://seller.example',
  AUTH_CLIENT_HASH_KEY: 'ab'.repeat(32),
};

// D-18 private-alpha boundary at the process level: the web process binds to loopback unless an
// operator explicitly allows a network bind for an internal demonstration.

describe('Configuration', () => {
  it('defaults the web process to the loopback interface', () => {
    const config = loadWebConfig({ ...AUTH_ENV, DATABASE_URL: 'postgresql://runtime@localhost/marketplace' });
    expect(config.host).toBe('127.0.0.1');
    expect(config.appEnv).toBe('local');
    expect(config.port).toBe(0);
  });

  it('refuses a non-loopback bind unless BACKEND_ALLOW_NETWORK_BIND=true', () => {
    expect(() => loadWebConfig({ ...AUTH_ENV, DATABASE_URL: 'postgresql://x', HOST: '0.0.0.0' })).toThrow(
      /loopback/,
    );
    expect(
      loadWebConfig({
        ...AUTH_ENV,
        DATABASE_URL: 'postgresql://x',
        HOST: '0.0.0.0',
        BACKEND_ALLOW_NETWORK_BIND: 'true',
      }).host,
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
    expect(() => loadWebConfig({ ...AUTH_ENV, DATABASE_URL: 'postgresql://x', APP_ENV: 'demo' })).toThrow();
  });

  it('requires the seller-authentication settings and validates them (D-19)', () => {
    expect(() => loadWebConfig({ DATABASE_URL: 'postgresql://x' })).toThrow();
    const ok = loadAuthConfig(
      { ...AUTH_ENV, AUTH_TRUSTED_PROXIES: ' 10.0.0.0/8 , 192.0.2.10 ', AUTH_CLIENT_HASH_KEY_VERSION: '2' },
      'production',
    );
    expect(ok.sellerOrigin).toBe('https://seller.example');
    expect(ok.clientHashKey.length).toBe(32);
    expect(ok.clientHashKeyVersion).toBe(2);
    expect(ok.trustedProxies).toEqual(['10.0.0.0/8', '192.0.2.10']);
    expect(ok.sessionIdleSeconds).toBe(12 * 60 * 60);
    expect(ok.sessionAbsoluteSeconds).toBe(30 * 24 * 60 * 60);
    // D-20: the recorded private-alpha default of the active-session cap, and its bounds.
    expect(ok.maxActiveSessions).toBe(10);
    expect(loadAuthConfig({ ...AUTH_ENV, AUTH_MAX_ACTIVE_SESSIONS: '3' }, 'local').maxActiveSessions).toBe(3);
    expect(() => loadAuthConfig({ ...AUTH_ENV, AUTH_MAX_ACTIVE_SESSIONS: '0' }, 'local')).toThrow();
    expect(() => loadAuthConfig({ ...AUTH_ENV, AUTH_MAX_ACTIVE_SESSIONS: '51' }, 'local')).toThrow();
    expect(() => loadAuthConfig({ ...AUTH_ENV, AUTH_CLIENT_HASH_KEY: 'too-short' }, 'local')).toThrow();
    expect(() => loadAuthConfig({ ...AUTH_ENV, AUTH_CLIENT_HASH_KEY: 'AB'.repeat(32) }, 'local')).toThrow(
      /hex/,
    );
    expect(() =>
      loadAuthConfig({ ...AUTH_ENV, AUTH_SELLER_ORIGIN: 'https://seller.example/app' }, 'local'),
    ).toThrow(/origin/);
    expect(() =>
      loadAuthConfig({ ...AUTH_ENV, AUTH_SELLER_ORIGIN: 'http://seller.example' }, 'local'),
    ).toThrow(/loopback/);
    expect(() =>
      loadAuthConfig({ ...AUTH_ENV, AUTH_SELLER_ORIGIN: 'http://localhost:3000' }, 'staging'),
    ).toThrow(/https/);
    expect(
      loadAuthConfig({ ...AUTH_ENV, AUTH_SELLER_ORIGIN: 'http://localhost:3000' }, 'local').sellerOrigin,
    ).toBe('http://localhost:3000');
    expect(() => loadAuthConfig({ ...AUTH_ENV, AUTH_SESSION_IDLE_SECONDS: '10' }, 'local')).toThrow();
  });
});
