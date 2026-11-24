const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const test = require('node:test');
const { readBootstrapConfig } = require('../dist/admin/bootstrap-admin');

const password = randomBytes(24).toString('base64url');
const databaseUrl = 'postgresql://offline@127.0.0.1:1/affiliate_marketing_admin_bootstrap_test_unit';
const valid = {
  BOOTSTRAP_ADMIN_NAME: 'Bootstrap operator',
  BOOTSTRAP_ADMIN_PHONE: '0999300001',
  BOOTSTRAP_ADMIN_PASSWORD: password,
  DATABASE_URL: databaseUrl,
};

test('bootstrap requires every value and preserves the configured credentials exactly', () => {
  for (const key of Object.keys(valid)) {
    assert.throws(() => readBootstrapConfig({ ...valid, [key]: undefined }), /Set BOOTSTRAP_ADMIN_NAME/);
  }
  const config = readBootstrapConfig(valid);
  assert.equal(config.name, valid.BOOTSTRAP_ADMIN_NAME);
  assert.equal(config.phone, valid.BOOTSTRAP_ADMIN_PHONE);
  assert.ok(config.password === password);
  assert.ok(config.databaseUrl === databaseUrl);
  assert.equal(config.databaseName, 'affiliate_marketing_admin_bootstrap_test_unit');
});

test('bootstrap validates registration name and phone rules and its stronger password requirements', () => {
  for (const overrides of [
    { BOOTSTRAP_ADMIN_NAME: '  ' }, { BOOTSTRAP_ADMIN_NAME: 'n'.repeat(121) },
    { BOOTSTRAP_ADMIN_PHONE: '0899300001' }, { BOOTSTRAP_ADMIN_PHONE: '099930001' },
    { BOOTSTRAP_ADMIN_PASSWORD: 'short' }, { BOOTSTRAP_ADMIN_PASSWORD: ' '.repeat(16) },
    { BOOTSTRAP_ADMIN_PASSWORD: 'é'.repeat(37) },
  ]) {
    assert.throws(() => readBootstrapConfig({ ...valid, ...overrides }), /Use a/);
  }
  const boundary = 'é'.repeat(36);
  assert.ok(readBootstrapConfig({ ...valid, BOOTSTRAP_ADMIN_PASSWORD: boundary }).password === boundary);
});

test('bootstrap rejects invalid PostgreSQL URLs and explicitly protects the development database', () => {
  for (const url of ['not-a-url', 'https://127.0.0.1/database', 'postgresql://127.0.0.1/', 'postgresql://127.0.0.1/%ZZ']) {
    assert.throws(() => readBootstrapConfig({ ...valid, DATABASE_URL: url }), /valid PostgreSQL URL/);
  }
  for (const name of ['affiliate_marketing_dev', '%61ffiliate_marketing_dev']) {
    assert.throws(() => readBootstrapConfig({ ...valid, DATABASE_URL: `postgresql://offline@127.0.0.1:1/${name}` }), /disabled for the local development database/);
  }
});

test('CLI exits with a configuration error without exposing its environment', () => {
  const result = spawnSync(process.execPath, [require.resolve('../dist/admin/bootstrap-admin')], {
    env: { ...process.env, ...valid, BOOTSTRAP_ADMIN_PHONE: 'invalid', JWT_SECRET: password },
    encoding: 'utf8', timeout: 8000, windowsHide: true,
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Syrian mobile number/);
  assert.equal((result.stdout + result.stderr).includes(password), false);
  assert.equal((result.stdout + result.stderr).includes(databaseUrl), false);
});
