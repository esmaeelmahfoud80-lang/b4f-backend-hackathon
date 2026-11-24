const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const test = require('node:test');
const { URL } = require('node:url');
const bcrypt = require('bcrypt');
const { AbortSignal } = globalThis;

const databaseUrl = process.env.ADMIN_BOOTSTRAP_INTEGRATION_DATABASE_URL;
const cli = '../dist/admin/bootstrap-admin';

test('initial admin CLI on isolated PostgreSQL', { skip: !databaseUrl, timeout: 60000 }, async (t) => {
  const url = new URL(databaseUrl);
  assert.ok(['postgresql:', 'postgres:'].includes(url.protocol) && url.hostname === '127.0.0.1' &&
    /^\/affiliate_marketing_admin_bootstrap_test_[a-z0-9_]+$/.test(url.pathname) && !url.search && !url.hash,
  'Expected a fresh loopback admin bootstrap test database');
  process.env.DATABASE_URL = databaseUrl;
  process.env.JWT_SECRET = randomBytes(32).toString('base64url');
  const { createApp } = require('../dist/main');
  const { PrismaService } = require('../dist/prisma/prisma.service');
  const app = await createApp({ logger: false });
  t.after(() => app.close());
  const db = app.get(PrismaService).getClient();
  const [identity] = await db.$queryRaw`SELECT current_database() AS db, host(inet_server_addr()) AS host`;
  assert.deepEqual(identity, { db: url.pathname.slice(1), host: '127.0.0.1' });
  assert.equal(await db.user.count(), 0, 'Expected a fresh database without any users');
  await app.listen(0, '127.0.0.1');
  const base = `${await app.getUrl()}/api/v1`;
  const publicPassword = randomBytes(24).toString('base64url');
  const publicPhone = '0999300001';
  const candidates = ['0999300002', '0999300003'].map((phone, index) => ({
    phone, name: `Bootstrap admin ${index + 1}`, password: randomBytes(24).toString('base64url'),
  }));

  async function request(path, { method = 'GET', token, body } = {}) {
    const response = await fetch(`${base}/${path}`, { method, signal: AbortSignal.timeout(8000),
      headers: { ...(token && { authorization: `Bearer ${token}` }),
        ...(body && { 'content-type': 'application/json' }) },
      body: body && JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }

  function run({ name, phone, password }) {
    return new Promise((resolve) => {
      execFile(process.execPath, [require.resolve(cli)], { timeout: 15000, windowsHide: true, env: {
        ...process.env, DATABASE_URL: databaseUrl, BOOTSTRAP_ADMIN_NAME: name,
        BOOTSTRAP_ADMIN_PHONE: phone, BOOTSTRAP_ADMIN_PASSWORD: password,
      } }, (error, stdout, stderr) => {
        const message = (stdout + stderr).trim();
        const secrets = [password, phone, process.env.JWT_SECRET, databaseUrl,
          decodeURIComponent(url.password)].filter(Boolean);
        const safe = secrets.every((value) => !message.includes(value));
        resolve({ status: error?.code ?? 0, message: safe ? message : '[redacted]', safe });
      });
    });
  }

  const publicSignup = { name: 'Public account', phone: publicPhone, password: publicPassword };
  const signup = (roles) => request('auth/register', { method: 'POST', body: { ...publicSignup, roles } });
  const forbidden = await signup(['admin']);
  assert.deepEqual([forbidden.status, forbidden.body.code], [400, 'VALIDATION_ERROR']);
  const publicAccount = await signup(['customer']);
  assert.equal(publicAccount.status, 201);
  const original = await db.user.findUniqueOrThrow({ where: { phone: publicPhone } });
  assert.deepEqual(await run({ ...publicSignup, password: candidates[0].password }), {
    status: 3, message: 'The supplied phone is already registered. No account was changed.', safe: true,
  });
  assert.equal(await db.user.count({ where: { isAdmin: true } }), 0);

  await t.test('an insert error rolls back and logs a generic failure', async (subtest) => {
    await db.$executeRaw`CREATE FUNCTION test_reject_bootstrap_admin() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.is_admin THEN RAISE EXCEPTION 'injected bootstrap insert failure'; END IF;
        RETURN NEW;
      END
    $$`;
    subtest.after(async () => {
      await db.$executeRaw`DROP TRIGGER IF EXISTS test_reject_bootstrap_admin ON users`;
      await db.$executeRaw`DROP FUNCTION test_reject_bootstrap_admin()`;
    });
    await db.$executeRaw`CREATE TRIGGER test_reject_bootstrap_admin AFTER INSERT ON users
      FOR EACH ROW EXECUTE FUNCTION test_reject_bootstrap_admin()`;
    assert.deepEqual(await run(candidates[0]), { status: 1,
      message: 'Admin bootstrap failed. Verify the target database, migration status and database permissions, then retry.', safe: true });
    assert.equal(await db.user.count(), 1);
    assert.equal(await db.userSession.count(), 1);
  });

  await t.test('concurrent CLI attempts create one admin, and retries preserve accounts and passwords', async () => {
    const results = await Promise.all(candidates.map(run));
    assert.ok(results.every(({ safe, status }) => safe && status === 0));
    assert.deepEqual(results.map(({ message }) => message).sort(), [
      'An administrator already exists. No account was changed.', 'Initial administrator created.',
    ]);
    const winner = candidates[results.findIndex(({ message }) => message === 'Initial administrator created.')];
    const admins = await db.user.findMany({ where: { isAdmin: true } });
    assert.equal(admins.length, 1);
    const [admin] = admins;
    assert.equal(admin.phone, winner.phone);
    assert.equal(admin.name, winner.name);
    assert.equal(admin.isCustomer, false);
    assert.equal(admin.isMarketer, false);
    assert.equal(await db.wallet.count({ where: { userId: admin.id } }), 0);
    assert.equal(await db.userSession.count({ where: { userId: admin.id } }), 0);
    assert.equal(await db.merchantProfile.count({ where: { userId: admin.id } }), 0);
    assert.equal(await db.customerProfile.count({ where: { userId: admin.id } }), 0);
    assert.equal(bcrypt.getRounds(admin.passwordHash), 10);
    assert.equal(await bcrypt.compare(winner.password, admin.passwordHash), true);

    const replacement = randomBytes(24).toString('base64url');
    for (const input of [winner, { ...winner, password: replacement }, publicSignup]) {
      assert.deepEqual(await run(input), { status: 0,
        message: 'An administrator already exists. No account was changed.', safe: true });
    }
    const persisted = await db.user.findUniqueOrThrow({ where: { id: admin.id } });
    const publicAfter = await db.user.findUniqueOrThrow({ where: { id: original.id } });
    assert.ok(persisted.passwordHash === admin.passwordHash);
    assert.ok(publicAfter.passwordHash === original.passwordHash);
    assert.deepEqual([publicAfter.name, publicAfter.isAdmin, publicAfter.isCustomer, publicAfter.isMarketer],
      [original.name, false, true, false]);
    assert.equal(await db.user.count(), 2);

    const credentials = { phone: winner.phone, password: winner.password };
    const adminLogin = await request('auth/admin/login', { method: 'POST', body: credentials });
    assert.equal(adminLogin.status, 200);
    assert.deepEqual(adminLogin.body.user.roles, ['admin']);
    const publicLogin = await request('auth/login', { method: 'POST', body: credentials });
    assert.deepEqual([publicLogin.status, publicLogin.body.code], [401, 'INVALID_CREDENTIALS']);
    const missing = await request('admin/merchants');
    assert.deepEqual([missing.status, missing.body.code], [401, 'AUTH_REQUIRED']);
    const wrongRole = await request('admin/merchants', { token: publicAccount.body.accessToken });
    assert.deepEqual([wrongRole.status, wrongRole.body.code], [403, 'FORBIDDEN']);
    assert.equal((await request('admin/merchants', { token: adminLogin.body.accessToken })).status, 200);
  });
});
