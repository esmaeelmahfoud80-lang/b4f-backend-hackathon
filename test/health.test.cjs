const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, rmdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://offline@127.0.0.1:1/health_unit_test';
const { createApp } = require('../dist/main');
const { PrismaService, DatabaseUnavailableError } = require('../dist/prisma/prisma.service');
const { ApiConfigurationError } = require('../dist/prisma/database-config');
const { validateApiConfig } = require('../dist/config/api-config');
const { cashbackThresholds } = require('../dist/config/cashback-thresholds');

test('GET /api/v1/health preserves the success response and hides database failure details', async (t) => {
  const app = await createApp({ logger: false });
  t.after(() => app.close());
  const prisma = app.get(PrismaService);
  prisma.onModuleInit = async () => {};
  prisma.checkConnection = async () => {};
  await app.listen(0, '127.0.0.1');

  const url = `${await app.getUrl()}/api/v1/health`;
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { status: 'ok' });

  prisma.checkConnection = async () => {
    throw new Error('A private database URL and SQL error would go here.');
  };
  const unavailable = await fetch(url);
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await unavailable.json(), {
    statusCode: 503, code: 'DATABASE_UNAVAILABLE', message: 'The service is temporarily unavailable.',
  });
});

test('readiness bounds an unresponsive query, shares the probe and discards the connection', async (t) => {
  const prisma = new PrismaService({ get: () => undefined });
  let release;
  let connections = 0;
  prisma.pool = { connect: async () => {
    connections++;
    return { query: () => new Promise(() => {}), release: (destroy) => { release = destroy; } };
  } };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const result = prisma.checkConnection();
  assert.equal(prisma.checkConnection(), result);
  const rejection = assert.rejects(result, DatabaseUnavailableError);
  await Promise.resolve();
  t.mock.timers.tick(2500);
  await rejection;
  assert.equal(connections, 1);
  assert.equal(release, true);
});

test('readiness releases a connection acquired after the deadline without running a query', async (t) => {
  const prisma = new PrismaService({ get: () => undefined });
  let acquire;
  let released = false;
  prisma.pool = { connect: () => new Promise((resolve) => { acquire = resolve; }) };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const rejection = assert.rejects(prisma.checkConnection(), DatabaseUnavailableError);
  t.mock.timers.tick(2500);
  await rejection;
  acquire({ query: () => assert.fail('Late connection should not be queried'), release: () => { released = true; } });
  await Promise.resolve();
  assert.equal(released, true);
});

test('production validates the database URL, signing secret and public web origin', () => {
  const config = { NODE_ENV: 'production', DATABASE_URL: process.env.DATABASE_URL,
    JWT_SECRET: 'z'.repeat(32), WEB_BASE_URL: 'https://web.example.test' };
  assert.equal(validateApiConfig(config), config);
  assert.throws(() => validateApiConfig({ ...config, DATABASE_URL: undefined }), /DATABASE_URL is required/);
  assert.throws(() => validateApiConfig({ ...config, DATABASE_URL: 'https://localhost/db' }), /must be a PostgreSQL URL/);
  assert.throws(() => validateApiConfig({ ...config, JWT_SECRET: 'short' }), /JWT_SECRET/);
  assert.throws(() => validateApiConfig({ ...config, WEB_BASE_URL: 'http://web.example.test' }), /WEB_BASE_URL/);
  assert.throws(() => validateApiConfig({ ...config, WEB_BASE_URL: 'https://web.example.test/path' }), /WEB_BASE_URL/);
  assert.doesNotThrow(() => validateApiConfig({ NODE_ENV: 'test' }));
});

test('startup accepts omitted cashback thresholds and valid overrides', () => {
  const cases = [
    [{}, { minimumPurchases: 5, minimumSpendSyp: 50000n }],
    [{ CASHBACK_MILESTONE_PURCHASES: '7' }, { minimumPurchases: 7, minimumSpendSyp: 50000n }],
    [{ CASHBACK_MILESTONE_SPEND_SYP: '75001' }, { minimumPurchases: 5, minimumSpendSyp: 75001n }],
    [{ CASHBACK_MILESTONE_PURCHASES: '2147483647', CASHBACK_MILESTONE_SPEND_SYP: '9007199254740991' },
      { minimumPurchases: 2147483647, minimumSpendSyp: 9007199254740991n }],
  ];
  for (const [settings, expected] of cases) {
    const config = { NODE_ENV: 'test', ...settings };
    assert.equal(validateApiConfig(config), config);
    assert.deepEqual(cashbackThresholds({ get: (key) => config[key] }), expected);
  }
});

test('startup rejects invalid cashback thresholds without echoing their values', () => {
  for (const [setting, overflow] of [
    ['CASHBACK_MILESTONE_PURCHASES', '2147483648'],
    ['CASHBACK_MILESTONE_SPEND_SYP', '9007199254740992'],
  ]) {
    for (const value of ['', '-1', '0', '1.5', 'invalid-threshold-fixture', '01', overflow]) {
      assert.throws(() => validateApiConfig({ NODE_ENV: 'test', [setting]: value }),
        (error) => error instanceof ApiConfigurationError && error.message.startsWith(`${setting} must be a positive integer`) &&
          !error.message.includes('invalid-threshold-fixture'));
    }
  }
});

test('the application rejects invalid cashback settings before listening in each environment', (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'affiliate-cashback-config-'));
  t.after(() => rmdirSync(cwd));
  const env = { ...process.env, JWT_SECRET: 'z'.repeat(32), WEB_BASE_URL: 'https://web.example.test', PORT: '3000' };
  delete env.CASHBACK_MILESTONE_PURCHASES;
  delete env.CASHBACK_MILESTONE_SPEND_SYP;
  for (const [mode, setting, value] of [
    ['development', 'CASHBACK_MILESTONE_PURCHASES', '0'],
    ['test', 'CASHBACK_MILESTONE_SPEND_SYP', '1.5'],
    ['production', 'CASHBACK_MILESTONE_SPEND_SYP', 'invalid-threshold-fixture'],
  ]) {
    const run = spawnSync(process.execPath, [require.resolve('../dist/main')], {
      cwd, env: { ...env, NODE_ENV: mode, [setting]: value }, encoding: 'utf8', timeout: 12000, windowsHide: true,
    });
    assert.equal(run.status, 1);
    assert.match(run.stderr, new RegExp(`^${setting} must be a positive integer`, 'm'));
    assert.doesNotMatch(run.stdout + run.stderr, /invalid-threshold-fixture|Nest application successfully started/);
  }
});

test('production startup fails clearly with missing, invalid or unreachable database configuration', (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'affiliate-health-'));
  t.after(() => rmdirSync(cwd));
  const secret = 'test-signing-secret-placeholder-for-startup';
  const env = { ...process.env, NODE_ENV: 'production', JWT_SECRET: secret, WEB_BASE_URL: 'https://web.example.test', PORT: '3000' };
  const databasePassword = 'private-startup-fixture-password';
  for (const [databaseUrl, expected] of [
    [undefined, /DATABASE_URL is required in production/],
    [`https://db-user:${databasePassword}@127.0.0.1/health_unit_test`, /DATABASE_URL must be a PostgreSQL URL/],
    [`postgresql://db-user:${databasePassword}@127.0.0.1:1/health_unit_test`, /PostgreSQL is unavailable/],
  ]) {
    const runEnv = { ...env };
    if (databaseUrl === undefined) delete runEnv.DATABASE_URL;
    else runEnv.DATABASE_URL = databaseUrl;
    const run = spawnSync(process.execPath, [require.resolve('../dist/main')], {
      cwd, env: runEnv, encoding: 'utf8', timeout: 12000, windowsHide: true,
    });
    assert.equal(run.status, 1);
    assert.match(run.stderr, expected);
    const output = run.stdout + run.stderr;
    assert.equal(output.includes(databasePassword) || output.includes(secret), false);
    assert.doesNotMatch(output, /Nest application successfully started/);
  }
});
