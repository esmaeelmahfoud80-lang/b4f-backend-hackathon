const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const test = require('node:test');
const { URL } = require('node:url');
const { AbortSignal } = globalThis;

const databaseUrl = process.env.HEALTH_INTEGRATION_DATABASE_URL;

test('readiness and shutdown use a fresh isolated PostgreSQL database', { skip: !databaseUrl, timeout: 15000 }, async (t) => {
  const url = new URL(databaseUrl);
  assert.ok(['postgresql:', 'postgres:'].includes(url.protocol) && url.hostname === '127.0.0.1' &&
    /^\/affiliate_marketing_health_test_[a-z0-9_]+$/.test(url.pathname) && !url.search && !url.hash,
  'Expected a fresh loopback health-test database');
  process.env.NODE_ENV = 'production';
  process.env.DATABASE_URL = databaseUrl;
  process.env.JWT_SECRET = randomBytes(32).toString('base64url');
  process.env.WEB_BASE_URL = 'https://web.example.test';
  const { createApp } = require('../dist/main');
  const { PrismaService, DatabaseUnavailableError } = require('../dist/prisma/prisma.service');
  const app = await createApp({ logger: false });
  let closed = false;
  t.after(async () => { if (!closed) await app.close(); });
  const prisma = app.get(PrismaService);
  const client = prisma.getClient();
  const [identity] = await client.$queryRaw`SELECT current_database() AS db, host(inet_server_addr()) AS host`;
  assert.deepEqual(identity, { db: url.pathname.slice(1), host: '127.0.0.1' });
  const snapshot = () => client.$queryRaw`
    SELECT (SELECT count(*) FROM users) AS users, (SELECT count(*) FROM user_sessions) AS sessions,
      (SELECT count(*) FROM campaigns) AS campaigns, (SELECT count(*) FROM wallets) AS wallets,
      (SELECT count(*) FROM sales) AS sales, (SELECT count(*) FROM money_movements) AS ledger,
      (SELECT count(*) FROM idempotency_records) AS idempotency
  `;
  const before = await snapshot();
  assert.ok(Object.values(before[0]).every((value) => value === 0n));
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  const response = await fetch(`${base}/api/v1/health`, { signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
  assert.deepEqual(await snapshot(), before);

  await app.close('SIGTERM');
  closed = true;
  assert.equal(app.getHttpServer().listening, false);
  await assert.rejects(prisma.checkConnection(), DatabaseUnavailableError);
});
