const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const test = require('node:test');
const { URL } = require('node:url');
const bcrypt = require('bcrypt');
const { Client } = require('pg');
const { AbortSignal } = globalThis;

const databaseUrl = process.env.ADMIN_TOPUP_INTEGRATION_DATABASE_URL;
const fixtureId = (key) => `aff111a7-e000-4000-8000-${String(key).padStart(12, '0')}`;

async function verifyBackfill() {
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5000, query_timeout: 8000 });
  await client.connect();
  try {
    // Run the migration SQL on session-local copies of the old tables, leaving public tables intact.
    await client.query(`
      SET lock_timeout = '5s';
      CREATE TEMP TABLE merchant_topups (LIKE public.merchant_topups);
      CREATE TEMP TABLE wallets (LIKE public.wallets);
      CREATE TEMP TABLE money_movements (LIKE public.money_movements);
      CREATE TEMP TABLE idempotency_records (LIKE public.idempotency_records);
      ALTER TABLE pg_temp.merchant_topups DROP COLUMN merchant_new_available_balance_syp;
      SET search_path TO pg_temp;
    `);
    const legacyId = randomUUID();
    for (const [key, amount, currentBalance] of [[2, 100000, 73500], [5, 435000, 0]]) {
      await client.query(`INSERT INTO wallets (id, user_id, role, available_balance_syp, pending_payout_syp)
        VALUES ($1, $2, 'merchant', $3, 0)`, [fixtureId(10 + key), fixtureId(key), currentBalance]);
      await client.query(`INSERT INTO merchant_topups (id, merchant_id, admin_id, amount_syp, payment_method, reference_note, created_at)
        VALUES ($1, $2, $3, $4, 'cash', 'Simulated demo opening credit', now())`, [fixtureId(20 + key), fixtureId(key), fixtureId(1), amount]);
      await client.query(`INSERT INTO money_movements (id, wallet_id, topup_id, kind, amount_syp, created_at)
        VALUES ($1, $2, $3, 'merchant_topup', $4, now())`, [fixtureId(30 + key), fixtureId(10 + key), fixtureId(20 + key), amount]);
    }
    // A lookalike with the same note and amount lacks the exact opening fixture identities.
    await client.query(`INSERT INTO merchant_topups (id, merchant_id, admin_id, amount_syp, payment_method, reference_note, created_at)
      VALUES ($1, $2, $3, 100000, 'cash', 'Simulated demo opening credit', now())`, [legacyId, fixtureId(2), fixtureId(1)]);
    await client.query(`INSERT INTO idempotency_records
      (actor_id, operation, request_key, request_fingerprint, response_status, response_body, created_at)
      VALUES ($1, 'demo.seed.v1', $2, 'demo-seed-v1', 201, '{}', now())`, [fixtureId(1), fixtureId(90)]);
    const migration = readFileSync(require.resolve('../prisma/migrations/0002_merchant_topup_balance_snapshot/migration.sql'), 'utf8');
    await client.query(migration);
    const { rows } = await client.query('SELECT id, merchant_new_available_balance_syp::text AS balance FROM pg_temp.merchant_topups');
    assert.deepEqual(new Map(rows.map(({ id, balance }) => [id, balance])), new Map([
      [fixtureId(22), '100000'], [fixtureId(25), '435000'], [legacyId, null],
    ]));
    for (const invalid of [-1, 99999, '9007199254740992']) {
      await assert.rejects(client.query('UPDATE pg_temp.merchant_topups SET merchant_new_available_balance_syp = $1 WHERE id = $2',
        [invalid, fixtureId(22)]), { code: '23514', constraint: 'merchant_topups_post_credit_balance_check' });
    }
  } finally {
    await client.end();
  }
}

test('Step 11B admin top-ups on isolated PostgreSQL', { skip: !databaseUrl, timeout: 60000 }, async (t) => {
  const url = new URL(databaseUrl);
  assert.ok(['postgresql:', 'postgres:'].includes(url.protocol) && url.hostname === '127.0.0.1' &&
    /^\/affiliate_marketing_admin_topup_test_[a-z0-9_]+$/.test(url.pathname) && !url.search && !url.hash,
  'Expected a fresh loopback admin top-up test database');
  process.env.DATABASE_URL = databaseUrl;
  process.env.JWT_SECRET = randomBytes(32).toString('base64url');
  process.env.WEB_BASE_URL = 'https://demo.example.test';
  const { createApp } = require('../dist/main');
  const { PrismaService } = require('../dist/prisma/prisma.service');
  const app = await createApp({ logger: false });
  t.after(() => app.close());
  const db = app.get(PrismaService).getClient();
  const [identity] = await db.$queryRaw`SELECT current_database() AS db, host(inet_server_addr()) AS host`;
  assert.equal(identity.db, url.pathname.slice(1));
  assert.equal(identity.host, '127.0.0.1');
  assert.equal(await db.user.count(), 0, 'Expected a fresh database without users');
  assert.equal(await db.merchantTopup.count(), 0, 'Expected a fresh database without top-ups');

  await t.test('migration backfills exact demo fixtures and retains unknowns with a bounded snapshot column', verifyBackfill);
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();

  function request(method, path, { token, key, body } = {}) {
    return fetch(`${base}/api/v1/${path}`, { method, headers: {
      ...(token && { authorization: `Bearer ${token}` }), ...(key && { 'Idempotency-Key': key }),
      ...(body !== undefined && { 'content-type': 'application/json' }),
    }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  }
  async function read(response, status) {
    assert.equal(response.status, status);
    return response.json();
  }
  async function fail(response, status, code) {
    assert.equal((await read(response, status)).code, code);
  }

  const password = randomBytes(24).toString('base64url');
  const passwordHash = await bcrypt.hash(password, 10);
  const loginAdmin = async (phone) => {
    const admin = await db.user.create({ data: { phone, name: 'Fixture admin', isAdmin: true, passwordHash } });
    const session = await read(await request('POST', 'auth/admin/login', { body: { phone, password } }), 200);
    return { id: admin.id, token: session.accessToken };
  };
  const admin = await loginAdmin('0999190001');
  const secondAdmin = await loginAdmin('0999190005');
  const register = async (suffix, roles) => {
    const body = { phone: `099919000${suffix}`, name: `Fixture ${suffix}`, password, roles,
      ...(roles.includes('merchant') && { shop: { name: `Shop ${suffix}`, details: 'Fixture shop' } }) };
    const session = await read(await request('POST', 'auth/register', { body }), 201);
    return { id: session.user.id, token: session.accessToken };
  };
  const merchant = await register(2, ['merchant', 'marketer', 'customer']);
  const other = await register(3, ['merchant']);
  const unverified = await register(4, ['merchant']);
  const marketer = await register(6, ['marketer']);
  await db.merchantProfile.updateMany({ where: { userId: { in: [merchant.id, other.id] } }, data: { verificationStatus: 'verified' } });

  const input = (amountSyp) => ({ amountSyp, paymentMethod: 'cash', referenceNote: 'Confirmed fixture payment' });
  const create = (amountSyp, { id = merchant.id, key = randomUUID(), token = admin.token, body = input(amountSyp) } = {}) =>
    request('POST', `admin/merchants/${id}/topups`, { token, key, body });
  const history = (search = '', token = admin.token) => request('GET', `admin/topups${search}`, { token });
  const wallet = (role = 'merchant', userId = merchant.id) => db.wallet.findUniqueOrThrow({ where: { userId_role: { userId, role } } });
  const customer = () => db.customerProfile.findUniqueOrThrow({ where: { userId: merchant.id } });
  const launch = () => request('POST', 'merchant/campaigns', { token: merchant.token, key: randomUUID(), body: {
    campaignType: 'product', productName: 'Fixture product', description: 'Fixture product for launch',
    imageUrl: 'https://demo.example.test/product.jpg', originalPriceSyp: 100000, discountPercent: 10,
    commission: { type: 'fixed', amountSyp: 10000 }, maxItems: 3, joinMode: 'open',
    endsAt: new Date(Date.now() + 3600000).toISOString(),
  } });

  await t.test('admin authentication, verified merchant, UUID and body validation', async () => {
    await fail(await history('', null), 401, 'AUTH_REQUIRED');
    await fail(await create(10, { token: null }), 401, 'AUTH_REQUIRED');
    await fail(await history('', merchant.token), 403, 'FORBIDDEN');
    await fail(await create(10, { token: merchant.token }), 403, 'FORBIDDEN');
    await fail(await create(10, { id: randomUUID() }), 404, 'NOT_FOUND');
    await fail(await create(10, { id: marketer.id }), 404, 'NOT_FOUND');
    await fail(await create(10, { id: unverified.id }), 403, 'MERCHANT_NOT_VERIFIED');
    await db.merchantProfile.update({ where: { userId: unverified.id }, data: { verificationStatus: 'rejected' } });
    await fail(await create(10, { id: unverified.id }), 403, 'MERCHANT_NOT_VERIFIED');
    await fail(await create(10, { id: 'invalid' }), 400, 'VALIDATION_ERROR');
    await fail(await create(10, { key: null }), 400, 'VALIDATION_ERROR');
    await fail(await create(10, { key: 'invalid' }), 400, 'VALIDATION_ERROR');
    for (const amount of [0, -1, 1.5, '10', Number.MAX_SAFE_INTEGER + 1]) {
      await fail(await create(amount), 400, 'VALIDATION_ERROR');
    }
    for (const fields of [{ paymentMethod: 'card' }, { referenceNote: ' ' }, { referenceNote: 'x'.repeat(257) }, { adminId: admin.id }]) {
      await fail(await create(10, { body: { ...input(10), ...fields } }), 400, 'VALIDATION_ERROR');
    }
    for (const search of ['?page=0', '?pageSize=101', '?merchantId=invalid']) {
      await fail(await history(search), 400, 'VALIDATION_ERROR');
    }
    assert.equal(await db.merchantTopup.count(), 0);
  });

  let first;
  let campaign;
  await t.test('top-ups credit only the merchant wallet and enable campaign launch without rewriting the snapshot', async () => {
    await fail(await launch(), 409, 'INSUFFICIENT_MERCHANT_BALANCE');
    const marketerBefore = await wallet('marketer');
    const customerBefore = await customer();
    const key = randomUUID();
    first = await read(await create(100000, { key }), 201);
    assert.deepEqual(first, { topupId: first.topupId, merchantId: merchant.id, shopName: 'Shop 2', ...input(100000),
      merchantNewAvailableBalanceSyp: 100000, createdAt: first.createdAt });
    const row = await db.merchantTopup.findUniqueOrThrow({ where: { id: first.topupId }, include: { moneyMovements: true } });
    assert.equal(row.createdAt.toISOString(), first.createdAt);
    assert.equal(row.adminId, admin.id);
    assert.equal(row.amountSyp, 100000n);
    assert.equal(row.merchantNewAvailableBalanceSyp, 100000n);
    const merchantWallet = await wallet();
    assert.equal(merchantWallet.availableBalanceSyp, 100000n);
    assert.deepEqual(row.moneyMovements.map(({ topupId, walletId, amountSyp, kind, campaignId, saleId, customerId }) =>
      ({ topupId, walletId, amountSyp, kind, campaignId, saleId, customerId })), [
      { topupId: first.topupId, walletId: merchantWallet.id, amountSyp: 100000n, kind: 'merchant_topup', campaignId: null, saleId: null, customerId: null },
    ]);
    campaign = await read(await launch(), 201);
    assert.equal(campaign.usage.lockedBudgetSyp, 43500);
    assert.equal((await wallet()).availableBalanceSyp, 56500n);
    assert.equal((await read(await create(5000), 201)).merchantNewAvailableBalanceSyp, 61500);
    assert.equal((await read(await create(1000), 201)).merchantNewAvailableBalanceSyp, 62500);
    const replay = await read(await create(100000, { key }), 201);
    assert.deepEqual(replay, first);
    await fail(await create(100001, { key }), 409, 'IDEMPOTENCY_KEY_REUSED');
    await fail(await create(100000, { key, id: other.id }), 409, 'IDEMPOTENCY_KEY_REUSED');
    await read(await create(10, { key, id: other.id, token: secondAdmin.token }), 201);
    assert.equal((await wallet()).availableBalanceSyp, 62500n);
    assert.equal((await wallet('merchant', other.id)).availableBalanceSyp, 10n);
    assert.deepEqual(await wallet('marketer'), marketerBefore);
    assert.deepEqual(await customer(), customerBefore);
    assert.equal((await db.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).lockedBudgetSyp, 43500n);
  });

  await t.test('concurrent same-key and distinct-key top-ups each produce one credit per committed key', async () => {
    const before = (await wallet()).availableBalanceSyp;
    const count = await db.merchantTopup.count();
    const key = randomUUID();
    const same = await Promise.all([create(200, { key }), create(200, { key })]);
    const [result, replay] = await Promise.all(same.map((response) => read(response, 201)));
    assert.deepEqual(result, replay);
    assert.equal(result.merchantNewAvailableBalanceSyp, Number(before + 200n));
    const distinct = await Promise.all([create(300), create(400)]);
    const [left, right] = await Promise.all(distinct.map((response) => read(response, 201)));
    const final = Number(before + 900n);
    assert.ok(
      (left.merchantNewAvailableBalanceSyp === final - 400 && right.merchantNewAvailableBalanceSyp === final) ||
      (right.merchantNewAvailableBalanceSyp === final - 300 && left.merchantNewAvailableBalanceSyp === final),
    );
    assert.equal((await wallet()).availableBalanceSyp, before + 900n);
    assert.equal(await db.merchantTopup.count(), count + 3);
    for (const entry of [result, left, right]) {
      const topup = await db.merchantTopup.findUniqueOrThrow({ where: { id: entry.topupId }, include: { moneyMovements: true } });
      assert.equal(topup.merchantNewAvailableBalanceSyp, BigInt(entry.merchantNewAvailableBalanceSyp));
      assert.equal(topup.moneyMovements.length, 1);
      assert.equal(topup.moneyMovements[0].amountSyp, BigInt(entry.amountSyp));
    }
  });

  await t.test('a failed ledger insert rolls back the top-up, credit and idempotency claim', async (subtest) => {
    const before = await wallet();
    const key = randomUUID();
    const topupsBefore = await db.merchantTopup.count();
    const ledgerBefore = await db.moneyMovement.count();
    await db.$executeRaw`ALTER TABLE money_movements ADD CONSTRAINT test_topup_ledger_failure
      CHECK (kind <> 'merchant_topup' OR amount_syp <> 19) NOT VALID`;
    subtest.after(() => db.$executeRaw`ALTER TABLE money_movements DROP CONSTRAINT test_topup_ledger_failure`);
    await fail(await create(19, { key }), 500, 'INTERNAL_ERROR');
    assert.deepEqual(await wallet(), before);
    assert.equal(await db.merchantTopup.count(), topupsBefore);
    assert.equal(await db.moneyMovement.count(), ledgerBefore);
    assert.equal(await db.idempotencyRecord.count({ where: { requestKey: key, actorId: admin.id } }), 0);
  });

  await t.test('the safe integer limit is enforced before any credit is written', async () => {
    const key = randomUUID();
    const before = await wallet('merchant', other.id);
    const topups = await db.merchantTopup.count();
    const movements = await db.moneyMovement.count();
    await fail(await create(Number.MAX_SAFE_INTEGER, { id: other.id, key }), 409, 'AMOUNT_OUT_OF_RANGE');
    assert.deepEqual(await wallet('merchant', other.id), before);
    assert.equal(await db.merchantTopup.count(), topups);
    assert.equal(await db.moneyMovement.count(), movements);
    assert.equal(await db.idempotencyRecord.count({ where: { requestKey: key, actorId: admin.id } }), 0);
  });

  await t.test('history pages, filters and returns stored snapshots or an explicit legacy null', async () => {
    const legacy = await db.merchantTopup.create({ data: { merchantId: other.id, adminId: admin.id, amountSyp: 20n,
      paymentMethod: 'bank_transfer', referenceNote: 'Imported fixture with unknown historical balance' } });
    const sameTime = new Date();
    await db.merchantTopup.updateMany({ data: { createdAt: sameTime } });
    const records = await db.merchantTopup.findMany();
    const ids = records.map(({ id }) => id).sort().reverse();
    const page = await read(await history('?page=2&pageSize=2'), 200);
    assert.deepEqual({ ...page, items: page.items.map(({ topupId }) => topupId) }, {
      items: ids.slice(2, 4), page: 2, pageSize: 2, total: ids.length, previousPage: 1, nextPage: 3,
    });
    const all = await read(await history(), 200);
    assert.deepEqual(all.items.map(({ topupId }) => topupId), ids);
    const historicalFirst = all.items.find(({ topupId }) => topupId === first.topupId);
    assert.deepEqual(historicalFirst, { ...first, createdAt: sameTime.toISOString() });
    const filtered = await read(await history(`?merchantId=${other.id}`), 200);
    assert.equal(filtered.total, 2);
    assert.ok(filtered.items.every(({ merchantId }) => merchantId === other.id));
    assert.equal(filtered.items.find(({ topupId }) => topupId === legacy.id).merchantNewAvailableBalanceSyp, null);
    assert.deepEqual((await read(await history('?page=999'), 200)).items, []);
  });

  await t.test('Swagger differentiates numeric POST and nullable history balances and declares authorization', async () => {
    const docs = await read(await fetch(`${base}/api/docs-json`, { signal: AbortSignal.timeout(5000) }), 200);
    const createOperation = docs.paths['/api/v1/admin/merchants/{merchantId}/topups'].post;
    const historyOperation = docs.paths['/api/v1/admin/topups'].get;
    for (const operation of [createOperation, historyOperation]) assert.deepEqual(operation.security, [{ bearer: [] }]);
    const key = createOperation.parameters.find(({ name }) => name === 'Idempotency-Key');
    assert.equal(key.required, true);
    assert.equal(key.schema.format, 'uuid');
    assert.equal(createOperation.requestBody.content['application/json'].schema.$ref, '#/components/schemas/CreateAdminTopupDto');
    assert.equal(createOperation.responses['201'].content['application/json'].schema.$ref, '#/components/schemas/AdminTopupResultDto');
    assert.equal(historyOperation.responses['200'].content['application/json'].schema.$ref, '#/components/schemas/AdminTopupPageDto');
    assert.deepEqual(historyOperation.parameters.map(({ name }) => name).sort(), ['merchantId', 'page', 'pageSize']);
    const schemas = docs.components.schemas;
    const posted = schemas.AdminTopupResultDto.properties.merchantNewAvailableBalanceSyp;
    const historical = schemas.AdminTopupHistoryEntryDto.properties.merchantNewAvailableBalanceSyp;
    assert.equal(posted.type, 'integer');
    assert.ok(!posted.nullable);
    assert.equal(historical.type, 'integer');
    assert.equal(historical.nullable, true);
    assert.match(historical.description, /hundredths of one new Syrian Pound/);
    assert.equal(schemas.AdminTopupPageDto.properties.items.items.$ref, '#/components/schemas/AdminTopupHistoryEntryDto');
  });

  const maxMoney = BigInt(Number.MAX_SAFE_INTEGER);
  const reserve = 43500n;
  let nextPhone = 10;

  async function merchantFixture() {
    const phone = `0999190${String(++nextPhone).padStart(3, '0')}`;
    const account = await db.user.create({ data: {
      phone, name: 'Reserve fixture', passwordHash,
      merchantProfile: { create: { shopName: 'Reserve shop', shopDetails: 'Fixture details', verificationStatus: 'verified' } },
      wallets: { create: { role: 'merchant' } },
    } });
    const session = await read(await request('POST', 'auth/login', { body: { phone, password } }), 200);
    const credit = (amount, key) => create(Number(amount), { id: account.id, key });
    await read(await credit(100000n), 201);
    const launchFixture = () => request('POST', 'merchant/campaigns', { token: session.accessToken, key: randomUUID(), body: {
      campaignType: 'product', productName: 'Reserve fixture', description: 'Reserve headroom fixture',
      imageUrl: 'https://demo.example.test/product.jpg', originalPriceSyp: 100000, discountPercent: 10,
      commission: { type: 'fixed', amountSyp: 10000 }, maxItems: 3, joinMode: 'open',
      endsAt: new Date(Date.now() + 3600000).toISOString(),
    } });
    return {
      id: account.id, token: session.accessToken, credit, launch: launchFixture,
      close: (id) => request('POST', `merchant/campaigns/${id}/close`, { token: session.accessToken }),
      balance: () => wallet('merchant', account.id),
    };
  }

  function locked(id) {
    return db.campaign.findUniqueOrThrow({ where: { id }, select: { status: true, lockedBudgetSyp: true } });
  }

  async function finance(fixture) {
    const row = await fixture.balance();
    const topups = await db.merchantTopup.findMany({ where: { merchantId: fixture.id }, orderBy: { id: 'asc' } });
    const movements = await db.moneyMovement.findMany({ where: { walletId: row.id }, orderBy: { id: 'asc' } });
    return { available: row.availableBalanceSyp, topups, movements };
  }

  async function reconcile(fixture, expectedAvailable, expectedReserve) {
    const { available, topups, movements } = await finance(fixture);
    assert.equal(available, expectedAvailable);
    const byKind = (kind) => movements.filter((row) => row.kind === kind);
    const sum = (rows) => rows.reduce((total, row) => total + row.amountSyp, 0n);
    assert.equal(byKind('merchant_topup').length, topups.length);
    assert.equal(sum(byKind('merchant_topup')), sum(topups));
    assert.equal(available, sum(topups) - sum(byKind('campaign_reserve_lock')) + sum(byKind('campaign_reserve_unlock')));
    const aggregate = await db.campaign.aggregate({ where: { merchantId: fixture.id }, _sum: { lockedBudgetSyp: true } });
    assert.equal(aggregate._sum.lockedBudgetSyp ?? 0n, expectedReserve);
    assert.ok(available + expectedReserve <= maxMoney);
    return byKind('campaign_reserve_unlock');
  }

  await t.test('exact headroom closes at the maximum and a one-unit overflow rolls back', async () => {
    const fixture = await merchantFixture();
    const active = await read(await fixture.launch(), 201);
    const before = await finance(fixture);
    const key = randomUUID();
    await fail(await fixture.credit(maxMoney - 100000n + 1n, key), 409, 'AMOUNT_OUT_OF_RANGE');
    assert.deepEqual(await finance(fixture), before);
    assert.deepEqual(await locked(active.id), { status: 'active', lockedBudgetSyp: reserve });
    assert.equal(await db.idempotencyRecord.count({ where: { requestKey: key, actorId: admin.id } }), 0);

    const receipt = await read(await fixture.credit(maxMoney - 100000n, key), 201);
    assert.equal(BigInt(receipt.merchantNewAvailableBalanceSyp), maxMoney - reserve);
    await read(await fixture.close(active.id), 200);
    await read(await fixture.close(active.id), 200);
    assert.deepEqual(await locked(active.id), { status: 'ended', lockedBudgetSyp: 0n });
    const released = await reconcile(fixture, maxMoney, 0n);
    assert.deepEqual(released.map(({ campaignId, amountSyp }) => [campaignId, amountSyp]), [[active.id, reserve]]);
    const settled = await finance(fixture);
    assert.deepEqual(await read(await fixture.credit(maxMoney - 100000n, key), 201), receipt);
    await fail(await fixture.credit(1n, key), 409, 'IDEMPOTENCY_KEY_REUSED');
    assert.deepEqual(await finance(fixture), settled);
  });

  await t.test('all outstanding reserves count, including an expired campaign before reconciliation', async () => {
    const fixture = await merchantFixture();
    const firstCampaign = await read(await fixture.launch(), 201);
    const expired = await read(await fixture.launch(), 201);
    await db.campaign.update({ where: { id: expired.id }, data: {
      createdAt: new Date(Date.now() - 7200000), endsAt: new Date(Date.now() - 60000),
    } });
    const before = await finance(fixture);
    await fail(await fixture.credit(maxMoney - 100000n + reserve), 409, 'AMOUNT_OUT_OF_RANGE');
    assert.deepEqual(await finance(fixture), before);
    assert.deepEqual(await locked(expired.id), { status: 'active', lockedBudgetSyp: reserve });
    await read(await fixture.credit(maxMoney - 100000n), 201);
    await read(await fixture.close(firstCampaign.id), 200);
    const reconciled = await read(await request('GET', `merchant/campaigns/${expired.id}`, { token: fixture.token }), 200);
    assert.equal(reconciled.status, 'ended');
    const released = await reconcile(fixture, maxMoney, 0n);
    assert.deepEqual(new Map(released.map(({ campaignId, amountSyp }) => [campaignId, amountSyp])),
      new Map([[firstCampaign.id, reserve], [expired.id, reserve]]));
  });

  async function scannerFixture(fixture, campaignId) {
    const membership = await db.campaignMarketer.create({ data: { campaignId, marketerId: marketer.id, status: 'approved' } });
    const pass = await db.offerQrPass.create({ data: { campaignId, customerId: merchant.id, campaignMarketerId: membership.id,
      qrToken: randomBytes(32).toString('base64url'), passCode: `OF-${randomBytes(6).toString('hex').toUpperCase()}` } });
    const key = randomUUID();
    return () => request('POST', 'merchant/scanner/redeem-offer', { token: fixture.token, key,
      body: { code: pass.passCode, quantity: 1 } });
  }

  async function verifySale(campaignId, receipt, beforeCommission, beforeCashback) {
    assert.equal(receipt.marketerCommissionSyp, 10000);
    assert.equal(receipt.customerCashbackSyp, 1800);
    assert.equal(receipt.platformNetFeeSyp, 2700);
    assert.equal(receipt.remainingLockedBudgetSyp, 29000);
    assert.equal((await wallet('marketer', marketer.id)).availableBalanceSyp, beforeCommission + 10000n);
    assert.equal((await customer()).lockedCashbackSyp, beforeCashback + 1800n);
    assert.equal(await db.sale.count({ where: { campaignId } }), 1);
    const movements = await db.moneyMovement.findMany({ where: { saleId: receipt.saleId } });
    assert.equal(movements.length, 4);
    assert.deepEqual(new Map(movements.map(({ kind, amountSyp }) => [kind, amountSyp])), new Map([
      ['sale_reserve_debit', 14500n], ['marketer_commission_credit', 10000n],
      ['customer_cashback_accrual', 1800n], ['platform_net_fee', 2700n],
    ]));
  }

  await t.test('a partially consumed campaign uses remaining reserve and releases exactly that remainder', async () => {
    const fixture = await merchantFixture();
    const active = await read(await fixture.launch(), 201);
    const redeem = await scannerFixture(fixture, active.id);
    const beforeCommission = (await wallet('marketer', marketer.id)).availableBalanceSyp;
    const beforeCashback = (await customer()).lockedCashbackSyp;
    const receipt = await read(await redeem(), 201);
    await verifySale(active.id, receipt, beforeCommission, beforeCashback);
    const accepted = await read(await fixture.credit(maxMoney - 100000n + 14500n), 201);
    assert.equal(BigInt(accepted.merchantNewAvailableBalanceSyp), maxMoney - 29000n);
    await read(await fixture.close(active.id), 200);
    assert.deepEqual((await reconcile(fixture, maxMoney, 0n)).map(({ amountSyp }) => amountSyp), [29000n]);
  });

  const { setTimeout: delay } = require('node:timers/promises');
  async function behindWalletLock(fixture, run) {
    const blocker = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 3000, statement_timeout: 3000 });
    const work = [];
    await blocker.connect();
    try {
      const { rows: [gate] } = await blocker.query('SELECT pg_backend_pid() AS pid, current_database() AS db, host(inet_server_addr()) AS host');
      assert.deepEqual({ db: gate.db, host: gate.host }, identity);
      await blocker.query('BEGIN');
      const guard = await blocker.query("SELECT id FROM wallets WHERE user_id = $1::uuid AND role = 'merchant' FOR NO KEY UPDATE", [fixture.id]);
      assert.equal(guard.rowCount, 1);
      function queue(action) {
        const result = Promise.allSettled([action()]);
        work.push(result);
        return result;
      }
      async function waitFor(count) {
        const deadline = Date.now() + 2200;
        while (Date.now() < deadline) {
          const [waiting] = await db.$queryRaw`
            WITH RECURSIVE queue(pid) AS (
              SELECT ${gate.pid}::integer
              UNION
              SELECT activity.pid FROM pg_stat_activity activity
              JOIN queue ON queue.pid = ANY(pg_blocking_pids(activity.pid))
              WHERE datname = current_database()
            )
            SELECT count(*)::integer - 1 AS count FROM queue
          `;
          if (waiting.count >= count) return;
          await delay(15);
        }
        assert.fail(`Expected ${count} blocked wallet operations`);
      }
      await run({ queue, waitFor });
    } finally {
      await blocker.end().finally(() => Promise.all(work));
    }
    return (await Promise.all(work)).map(([result]) => {
      if (result.status === 'rejected') throw result.reason;
      return result.value;
    });
  }

  await t.test('competing top-ups at the cap commit only one credit', async () => {
    const fixture = await merchantFixture();
    const active = await read(await fixture.launch(), 201);
    const before = await finance(fixture);
    const keys = [randomUUID(), randomUUID()];
    const credit = maxMoney - 100000n;
    const responses = await behindWalletLock(fixture, async ({ queue, waitFor }) => {
      void queue(() => fixture.credit(credit, keys[0]));
      await waitFor(1);
      void queue(() => fixture.credit(credit, keys[1]));
      await waitFor(2);
    });
    assert.equal(responses[0].status, 201);
    await fail(responses[1], 409, 'AMOUNT_OUT_OF_RANGE');
    const after = await finance(fixture);
    assert.equal(after.topups.length, before.topups.length + 1);
    assert.equal(after.movements.length, before.movements.length + 1);
    assert.equal(await db.idempotencyRecord.count({ where: { requestKey: keys[1], actorId: admin.id } }), 0);
    await reconcile(fixture, maxMoney - reserve, reserve);
    await read(await fixture.close(active.id), 200);
    await reconcile(fixture, maxMoney, 0n);
  });

  await t.test('launch commits a new reserve before the waiting top-up rechecks headroom', async () => {
    const fixture = await merchantFixture();
    const [launchResponse, creditResponse] = await behindWalletLock(fixture, async ({ queue, waitFor }) => {
      void queue(fixture.launch);
      await waitFor(1);
      void queue(() => fixture.credit(maxMoney - 100000n + 1n));
      await waitFor(2);
    });
    const launched = await read(launchResponse, 201);
    assert.deepEqual(await locked(launched.id), { lockedBudgetSyp: reserve, status: 'active' });
    await fail(creditResponse, 409, 'AMOUNT_OUT_OF_RANGE');
    await reconcile(fixture, 100000n - reserve, reserve);
    assert.equal((await finance(fixture)).topups.length, 1);
  });

  await t.test('top-up does not wait on the campaign row held by competing closure', async () => {
    const fixture = await merchantFixture();
    const active = await read(await fixture.launch(), 201);
    const [creditResponse, closeResponse] = await behindWalletLock(fixture, async ({ queue, waitFor }) => {
      void queue(() => fixture.credit(maxMoney - 100000n));
      await waitFor(1);
      void queue(() => fixture.close(active.id));
      await waitFor(2);
    });
    assert.equal(BigInt((await read(creditResponse, 201)).merchantNewAvailableBalanceSyp), maxMoney - reserve);
    await read(closeResponse, 200);
    const released = await reconcile(fixture, maxMoney, 0n);
    assert.deepEqual(released.map(({ campaignId, amountSyp }) => [campaignId, amountSyp]), [[active.id, reserve]]);
  });

  await t.test('settlement reduces reserve before the competing top-up reads it', async () => {
    const fixture = await merchantFixture();
    const active = await read(await fixture.launch(), 201);
    const redeem = await scannerFixture(fixture, active.id);
    const beforeCommission = (await wallet('marketer', marketer.id)).availableBalanceSyp;
    const beforeCashback = (await customer()).lockedCashbackSyp;
    let receipt;
    const [creditResponse] = await behindWalletLock(fixture, async ({ queue, waitFor }) => {
      void queue(() => fixture.credit(maxMoney - 100000n + 14500n));
      await waitFor(1);
      receipt = await read(await redeem(), 201);
    });
    await read(creditResponse, 201);
    await verifySale(active.id, receipt, beforeCommission, beforeCashback);
    assert.deepEqual(await read(await redeem(), 201), receipt);
    await reconcile(fixture, maxMoney - 29000n, 29000n);
    await read(await fixture.close(active.id), 200);
    await reconcile(fixture, maxMoney, 0n);
  });

  await t.test('history sanitizes an unexpected read failure and preserves an existing domain error', async (subtest) => {
    const { ConflictException } = require('@nestjs/common');
    const detail = 'synthetic private database failure';
    let failure = new Error(detail);
    const failingClient = new Proxy(db, { get: (target, property) => property === '$transaction'
      ? async () => { throw failure; } : Reflect.get(target, property) });
    subtest.mock.method(app.get(PrismaService), 'getClient', () => failingClient);
    const body = await read(await history(), 500);
    assert.deepEqual(body, { statusCode: 500, code: 'INTERNAL_ERROR', message: 'Unable to load merchant top-up history.' });
    assert.ok(!JSON.stringify(body).includes(detail));
    failure = new ConflictException({ statusCode: 409, code: 'AMOUNT_OUT_OF_RANGE', message: 'Fixture domain error.' });
    await fail(await history(), 409, 'AMOUNT_OUT_OF_RANGE');
  });

});
