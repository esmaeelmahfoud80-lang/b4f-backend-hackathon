const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const test = require('node:test');
const { URL } = require('node:url');
const { JwtService } = require('@nestjs/jwt');
const bcrypt = require('bcrypt');
const { Client } = require('pg');

const { AbortSignal } = globalThis;
const databaseUrl = process.env.PAYOUT_INTEGRATION_DATABASE_URL;
const maximum = BigInt(Number.MAX_SAFE_INTEGER);
const commission = 10000n;

test('simulated payouts over HTTP on isolated PostgreSQL', { skip: !databaseUrl, timeout: 60000 }, async (t) => {
  const url = new URL(databaseUrl);
  assert.ok(['postgresql:', 'postgres:'].includes(url.protocol) && url.hostname === '127.0.0.1' &&
    /^\/affiliate_marketing_payout_test_[a-z0-9_]+$/.test(url.pathname) && !url.search && !url.hash,
  'Expected a fresh loopback payout database');
  const secret = randomBytes(32).toString('base64url');
  Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: databaseUrl, JWT_SECRET: secret,
    WEB_BASE_URL: 'https://demo.example.test', CASHBACK_MILESTONE_PURCHASES: '5', CASHBACK_MILESTONE_SPEND_SYP: '50000',
    IMAGEKIT_PRIVATE_KEY: '', IMAGEKIT_URL_ENDPOINT: '' });
  const { createApp } = require('../dist/main');
  const { PrismaService } = require('../dist/prisma/prisma.service');
  const app = await createApp({ logger: false });
  t.after(() => app.close());
  const db = app.get(PrismaService).getClient();
  const [identity] = await db.$queryRaw`SELECT current_database() AS db, host(inet_server_addr()) AS host`;
  assert.deepEqual(identity, { db: url.pathname.slice(1), host: '127.0.0.1' });
  assert.equal(await db.user.count(), 0);
  assert.equal(await db.moneyMovement.count(), 0);
  assert.equal(await db.payoutRequest.count(), 0);

  await app.listen(0, '127.0.0.1');
  const origin = await app.getUrl();
  const base = origin + '/api/v1';
  async function call(method, path, { token, key, body } = {}) {
    const result = await fetch(base + path, {
      method, headers: { ...(token && { authorization: 'Bearer ' + token }), ...(key && { 'Idempotency-Key': key }),
        ...(body !== undefined && { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000),
    });
    return { status: result.status, noStore: result.headers.get('cache-control'), body: await result.json() };
  }
  async function expect(promise, status, code) {
    const result = await promise;
    assert.equal(result.status, status, result.body.code);
    if (code) assert.equal(result.body.code, code);
    return result.body;
  }

  let nextPhone = 0;
  const password = randomBytes(24).toString('base64url');
  const passwordHash = await bcrypt.hash(password, 10);
  const jwt = new JwtService();
  async function account(data) {
    const user = await db.user.create({ data: {
      phone: '099953' + String(++nextPhone).padStart(4, '0'), name: 'Payout fixture ' + nextPhone, passwordHash, ...data,
    } });
    const session = await db.userSession.create({ data: {
      userId: user.id, expiresAt: new Date(Date.now() + 3600000), refreshTokenHash: randomBytes(32).toString('hex'),
    } });
    return { id: user.id, name: user.name, token: jwt.sign({ sub: user.id, sid: session.id }, { secret, algorithm: 'HS256', expiresIn: 1800 }) };
  }

  const admin = await account({ isAdmin: true });
  const secondAdmin = await account({ isAdmin: true });
  const merchant = await account({
    merchantProfile: { create: { shopName: 'Payout shop', shopDetails: 'Fixture', verificationStatus: 'verified' } },
    wallets: { create: { role: 'merchant', availableBalanceSyp: 1000000n } },
  });
  const marketer = (balance = 0n, mix = false) => account({ isMarketer: true,
    ...(mix && { merchantProfile: { create: { shopName: 'Other shop', shopDetails: 'Role isolation fixture' } } }),
    wallets: { create: [{ role: 'marketer', availableBalanceSyp: balance },
      ...(mix ? [{ role: 'merchant', availableBalanceSyp: 123n }] : [])] },
  });
  const request = (user, amount, key = randomUUID()) =>
    call('POST', '/marketer/payouts', { token: user?.token, key, body: { expectedAmountSyp: amount } });
  const approve = (id, actor = admin) => call('PATCH', '/admin/payouts/' + id + '/approve', { token: actor?.token });
  const reject = (id, reason, actor = admin) => call('PATCH', '/admin/payouts/' + id + '/reject',
    { token: actor?.token, body: { reason } });
  const wallet = (user, role = 'marketer') => db.wallet.findUniqueOrThrow({ where: { userId_role: { userId: user.id, role } } });
  const walletApi = (user) => expect(call('GET', '/marketer/wallet', { token: user.token }), 200);
  const stats = (user) => expect(call('GET', '/marketer/stats', { token: user.token }), 200);
  const byMerchant = (user) => expect(call('GET', '/marketer/wallet/by-merchant', { token: user.token }), 200);
  const revenue = () => expect(call('GET', '/admin/revenue', { token: admin.token }), 200);
  const ledger = (id) => db.moneyMovement.findMany({ where: { payoutId: id }, orderBy: { kind: 'asc' } });
  const storedKey = (user, key) => db.idempotencyRecord.count({ where: { actorId: user.id, requestKey: key } });
  async function balance(user, available, pending) {
    const row = await wallet(user);
    assert.deepEqual([row.availableBalanceSyp, row.pendingPayoutSyp], [available, pending]);
    const records = await db.payoutRequest.findMany({ where: { marketerId: user.id, status: 'pending_review' } });
    assert.equal(records.reduce((sum, record) => sum + record.amountSyp, 0n), pending);
    assert.ok(records.length <= 1);
    return row;
  }

  async function saleFixture(user, maxItems = 3) {
    const customer = await account({ isCustomer: true, customerProfile: { create: {} } });
    const campaign = await expect(call('POST', '/merchant/campaigns', { token: merchant.token, key: randomUUID(), body: {
      campaignType: 'product', productName: 'Payout fixture', description: 'Payout scanner fixture',
      imageUrl: 'https://demo.example.test/product.jpg', originalPriceSyp: 100000, discountPercent: 10,
      commission: { type: 'fixed', amountSyp: Number(commission) }, maxItems, joinMode: 'open',
      endsAt: new Date(Date.now() + 3600000).toISOString(),
    } }), 201);
    const membership = await db.campaignMarketer.create({ data: { campaignId: campaign.id, marketerId: user.id, status: 'approved' } });
    const createPass = () => db.offerQrPass.create({ data: {
      campaignId: campaign.id, customerId: customer.id, campaignMarketerId: membership.id,
      qrToken: randomBytes(32).toString('base64url'), passCode: 'OF-' + randomBytes(6).toString('hex').toUpperCase(),
    } });
    const redeem = (pass, key = randomUUID()) => call('POST', '/merchant/scanner/redeem-offer',
      { token: merchant.token, key, body: { code: pass.passCode, quantity: 1 } });
    const cashback = () => db.customerProfile.findUniqueOrThrow({ where: { userId: customer.id } });
    return { campaign, pass: await createPass(), createPass, redeem, cashback };
  }

  await t.test('auth, role, invalid amounts, zero balance and stale confirmation cause no writes', async () => {
    const empty = await marketer();
    const funded = await marketer(50000n);
    const id = randomUUID();
    await expect(request(null, 1), 401, 'AUTH_REQUIRED');
    await expect(request(merchant, 1), 403, 'FORBIDDEN');
    await expect(request(admin, 1), 403, 'FORBIDDEN');
    await expect(call('GET', '/marketer/payouts'), 401, 'AUTH_REQUIRED');
    await expect(call('GET', '/marketer/payouts', { token: merchant.token }), 403, 'FORBIDDEN');
    await expect(call('GET', '/admin/payouts', { token: funded.token }), 403, 'FORBIDDEN');
    await expect(approve(id, null), 401, 'AUTH_REQUIRED');
    await expect(approve(id, funded), 403, 'FORBIDDEN');
    await expect(reject(id, 'reason', funded), 403, 'FORBIDDEN');
    await expect(approve(id), 404, 'NOT_FOUND');
    await expect(reject(id, 'reason'), 404, 'NOT_FOUND');
    await expect(approve('invalid'), 400, 'VALIDATION_ERROR');
    for (const amount of [undefined, null, 0, -1, 1.25, '50000', Number.MAX_SAFE_INTEGER + 1]) {
      await expect(request(funded, amount), 400, 'VALIDATION_ERROR');
    }
    for (const key of [null, 'invalid']) await expect(request(funded, 50000, key), 400, 'VALIDATION_ERROR');
    const emptyKey = randomUUID();
    const staleKey = randomUUID();
    await expect(request(empty, 1, emptyKey), 409, 'INSUFFICIENT_WALLET_BALANCE');
    await expect(request(funded, 49999, staleKey), 409, 'PAYOUT_AMOUNT_CHANGED');
    assert.equal(await storedKey(empty, emptyKey), 0);
    assert.equal(await storedKey(funded, staleKey), 0);
    await balance(empty, 0n, 0n);
    await balance(funded, 50000n, 0n);
    assert.equal(await db.payoutRequest.count(), 0);
    assert.equal(await db.moneyMovement.count(), 0);
  });

  await t.test('hold, fixed receipt replay and approval reconcile with earnings and other roles', async () => {
    const user = await marketer(40000n, true);
    const sale = await saleFixture(user);
    await expect(sale.redeem(sale.pass), 201);
    const beforeRevenue = await revenue();
    const beforeStats = await stats(user);
    const beforeBreakdown = await byMerchant(user);
    const beforeCashback = await sale.cashback();
    const beforeMerchant = await wallet(merchant, 'merchant');
    const beforeCampaign = await db.campaign.findUniqueOrThrow({ where: { id: sale.campaign.id } });
    const salesCount = await db.sale.count();
    assert.deepEqual(await walletApi(user), { availableBalanceSyp: 50000, pendingPayoutSyp: 0,
      totalEarnedSyp: 10000, totalConfirmedPaidOutSyp: 0 });

    const key = randomUUID();
    const response = await request(user, 50000, key);
    assert.equal(response.noStore, 'no-store');
    const held = await expect(response, 201);
    assert.deepEqual(held, { id: held.id, amountSyp: 50000, status: 'pending_review', createdAt: held.createdAt,
      decidedAt: null, rejectionReason: null });
    await balance(user, 0n, 50000n);
    assert.deepEqual((await ledger(held.id)).map(({ kind, amountSyp }) => [kind, amountSyp]), [['payout_hold', 50000n]]);
    await expect(request(user, 1), 409, 'PAYOUT_ALREADY_PENDING');
    assert.deepEqual(await expect(request(user, 50000, key), 201), held);
    await expect(request(user, 50001, key), 409, 'IDEMPOTENCY_KEY_REUSED');

    await expect(call('PATCH', '/admin/payouts/' + held.id + '/approve', { token: admin.token, body: { reason: 'Unexpected' } }),
      400, 'VALIDATION_ERROR');
    const approved = await expect(approve(held.id), 200);
    assert.deepEqual(approved, { ...held, status: 'confirmed', decidedAt: approved.decidedAt, marketerId: user.id, marketerName: user.name });
    assert.ok(approved.decidedAt);
    assert.equal((await db.payoutRequest.findUniqueOrThrow({ where: { id: held.id } })).decidedById, admin.id);
    await balance(user, 0n, 0n);
    assert.deepEqual(await expect(approve(held.id, secondAdmin), 200), approved);
    assert.deepEqual(await expect(request(user, 50000, key), 201), held);
    await expect(reject(held.id, 'cannot reverse'), 409, 'INVALID_STATUS_TRANSITION');
    assert.deepEqual((await ledger(held.id)).map(({ kind }) => kind), ['payout_hold', 'payout_completed']);
    const history = await expect(call('GET', '/marketer/wallet/transactions', { token: user.token }), 200);
    assert.deepEqual(new Set(history.items.map(({ kind }) => kind)), new Set(['marketer_commission_credit', 'payout_hold', 'payout_completed']));
    for (const entry of history.items.filter(({ kind }) => kind.startsWith('payout_'))) {
      assert.deepEqual([entry.campaignId, entry.campaignName, entry.shopName], [null, null, null]);
    }
    assert.deepEqual(await walletApi(user), { availableBalanceSyp: 0, pendingPayoutSyp: 0,
      totalEarnedSyp: 10000, totalConfirmedPaidOutSyp: 50000 });
    assert.deepEqual(await stats(user), beforeStats);
    assert.deepEqual(await byMerchant(user), beforeBreakdown);
    assert.deepEqual(await revenue(), beforeRevenue);
    assert.deepEqual(await sale.cashback(), beforeCashback);
    assert.deepEqual(await wallet(merchant, 'merchant'), beforeMerchant);
    assert.deepEqual(await db.campaign.findUniqueOrThrow({ where: { id: sale.campaign.id } }), beforeCampaign);
    assert.equal(await db.sale.count(), salesCount);
    assert.equal((await wallet(user, 'merchant')).availableBalanceSyp, 123n);
  });

  await t.test('rejects with a normalized reason, restores funds once, and supports history filtering', async () => {
    const user = await marketer(12000n);
    const other = await marketer(3000n);
    const held = await expect(request(user, 12000), 201);
    const otherHold = await expect(request(other, 3000), 201);
    for (const reason of [undefined, null, 7, '', '  ', 'x'.repeat(501)]) {
      await expect(reject(held.id, reason), 400, 'VALIDATION_ERROR');
    }
    await balance(user, 0n, 12000n);
    const reason = 'Confirm the demo ledger';
    const rejected = await expect(reject(held.id, '  ' + reason + '  '), 200);
    assert.deepEqual([rejected.status, rejected.rejectionReason], ['rejected', reason]);
    assert.deepEqual(await expect(reject(held.id, reason), 200), rejected);
    await expect(reject(held.id, 'Another reason'), 409, 'INVALID_STATUS_TRANSITION');
    await expect(approve(held.id), 409, 'INVALID_STATUS_TRANSITION');
    await balance(user, 12000n, 0n);
    const next = await expect(request(user, 12000), 201);
    await expect(reject(next.id, 'Another historical payout'), 200);
    await db.payoutRequest.updateMany({ where: { id: { in: [held.id, next.id] } }, data: { createdAt: new Date(0) } });
    const newest = [held.id, next.id].sort().reverse();
    assert.deepEqual((await ledger(held.id)).map(({ kind }) => kind), ['payout_hold', 'payout_release_refund']);
    const own = await expect(call('GET', '/marketer/payouts?status=rejected&pageSize=1', { token: user.token }), 200);
    assert.deepEqual([own.total, own.page, own.pageSize, own.previousPage, own.nextPage], [2, 1, 1, null, 2]);
    assert.equal(own.items[0].id, newest[0]);
    assert.deepEqual(Object.keys(own.items[0]).sort(), ['amountSyp', 'createdAt', 'decidedAt', 'id', 'rejectionReason', 'status']);
    const secondPage = await expect(call('GET', '/marketer/payouts?status=rejected&page=2&pageSize=1', { token: user.token }), 200);
    assert.equal(secondPage.items[0].id, newest[1]);
    const adminPage = await expect(call('GET', '/admin/payouts?status=pending_review&pageSize=1', { token: admin.token }), 200);
    assert.equal(adminPage.total, 1);
    assert.deepEqual(adminPage.items[0], { ...otherHold, marketerId: other.id, marketerName: other.name });
    await expect(call('GET', '/admin/payouts?status=transferred', { token: admin.token }), 400, 'VALIDATION_ERROR');
    await expect(call('GET', '/marketer/payouts?page=0', { token: user.token }), 400, 'VALIDATION_ERROR');
    await expect(reject(otherHold.id, 'Cleanup fixture'), 200);
  });

  const blocker = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 3000, statement_timeout: 3000 });
  await blocker.connect();
  t.after(() => blocker.end());
  const { rows: [gate] } = await blocker.query('SELECT pg_backend_pid() AS pid, current_database() AS db, host(inet_server_addr()) AS host');
  assert.deepEqual({ db: gate.db, host: gate.host }, identity);

  async function race(user, first, second) {
    const results = [];
    const walletId = (await wallet(user)).id;
    async function queued(count) {
      const deadline = Date.now() + 2400;
      while (Date.now() < deadline) {
        const [result] = await db.$queryRaw`
          WITH RECURSIVE waiters(pid) AS (
            SELECT ${gate.pid}::integer
            UNION
            SELECT activity.pid FROM pg_stat_activity activity
            JOIN waiters ON waiters.pid = ANY(pg_blocking_pids(activity.pid))
            WHERE datname = current_database()
          )
          SELECT count(*)::integer - 1 AS count FROM waiters
        `;
        if (result.count >= count) return;
        await delay(15);
      }
      assert.fail('Expected both HTTP transactions to compete for the marketer wallet lock');
    }
    await blocker.query('BEGIN');
    try {
      await blocker.query('SELECT id FROM wallets WHERE id = $1::uuid FOR UPDATE', [walletId]);
      results.push(Promise.allSettled([first()]));
      await queued(1);
      results.push(Promise.allSettled([second()]));
      await queued(2);
    } finally {
      await blocker.query('ROLLBACK').finally(() => Promise.all(results));
    }
    return (await Promise.all(results)).map(([result]) => {
      if (result.status === 'rejected') throw result.reason;
      return result.value;
    });
  }

  await t.test('concurrent requests and ledger constraints prevent duplicate or misattributed holds', async () => {
    const user = await marketer(6000n);
    const other = await marketer(1n);
    const losingKey = randomUUID();
    const [first, second] = await race(user, () => request(user, 6000), () => request(user, 6000, losingKey));
    const held = await expect(first, 201);
    await expect(second, 409, 'PAYOUT_ALREADY_PENDING');
    assert.equal(await storedKey(user, losingKey), 0);
    const ownWallet = await balance(user, 0n, 6000n);
    const otherWallet = await wallet(other);
    assert.equal((await ledger(held.id)).length, 1);
    await assert.rejects(db.payoutRequest.create({ data: { marketerId: user.id, walletId: ownWallet.id, amountSyp: 1n } }), { code: 'P2002' });
    await assert.rejects(db.moneyMovement.create({ data: { payoutId: held.id, walletId: otherWallet.id,
      kind: 'payout_release_refund', amountSyp: 6000n } }), { code: 'P2003' });
    await assert.rejects(db.moneyMovement.create({ data: { payoutId: held.id, walletId: ownWallet.id,
      kind: 'payout_release_refund', amountSyp: 5000n } }), { code: 'P2003' });
    await expect(approve(held.id), 200);
    await assert.rejects(db.moneyMovement.create({ data: { payoutId: held.id, walletId: ownWallet.id,
      kind: 'payout_release_refund', amountSyp: 6000n } }), { code: 'P2002' });
  });

  await t.test('concurrent decisions are state-idempotent and exclude a competing terminal result', async () => {
    for (const [firstDecision, secondDecision, secondStatus, available, kinds] of [
      ['approve', 'approve', 200, 0n, ['payout_hold', 'payout_completed']],
      ['reject', 'reject', 200, 7000n, ['payout_hold', 'payout_release_refund']],
      ['approve', 'reject', 409, 0n, ['payout_hold', 'payout_completed']],
      ['reject', 'approve', 409, 7000n, ['payout_hold', 'payout_release_refund']],
    ]) {
      const user = await marketer(7000n);
      const held = await expect(request(user, 7000), 201);
      const action = (kind, actor) => kind === 'approve' ? approve(held.id, actor) : reject(held.id, 'Same reason', actor);
      const [first, second] = await race(user, () => action(firstDecision, admin), () => action(secondDecision, secondAdmin));
      const winner = await expect(first, 200);
      const replay = await expect(second, secondStatus, secondStatus === 409 ? 'INVALID_STATUS_TRANSITION' : undefined);
      if (secondStatus === 200) assert.deepEqual(replay, winner);
      assert.equal((await db.payoutRequest.findUniqueOrThrow({ where: { id: held.id } })).decidedById, admin.id);
      await balance(user, available, 0n);
      assert.deepEqual((await ledger(held.id)).map(({ kind }) => kind), kinds);
    }
  });

  await t.test('ledger failures roll back holds and terminal decisions', async () => {
    const user = await marketer(1777n);
    const key = randomUUID();
    await db.$executeRaw`ALTER TABLE money_movements ADD CONSTRAINT payout_fixture_ledger_failure
      CHECK (amount_syp <> 1777 OR kind NOT IN ('payout_hold', 'payout_completed')) NOT VALID`;
    let held;
    try {
      await expect(request(user, 1777, key), 500, 'INTERNAL_ERROR');
      assert.equal(await storedKey(user, key), 0);
      await balance(user, 1777n, 0n);
      assert.equal(await db.payoutRequest.count({ where: { marketerId: user.id } }), 0);
      assert.equal(await db.moneyMovement.count({ where: { walletId: (await wallet(user)).id } }), 0);
    } finally {
      await db.$executeRaw`ALTER TABLE money_movements DROP CONSTRAINT payout_fixture_ledger_failure`;
    }
    held = await expect(request(user, 1777, key), 201);
    await db.$executeRaw`ALTER TABLE money_movements ADD CONSTRAINT payout_fixture_ledger_failure
      CHECK (amount_syp <> 1777 OR kind <> 'payout_completed') NOT VALID`;
    try {
      await expect(approve(held.id), 500, 'INTERNAL_ERROR');
      await balance(user, 0n, 1777n);
      const payout = await db.payoutRequest.findUniqueOrThrow({ where: { id: held.id } });
      assert.deepEqual([payout.status, payout.decidedAt, payout.decidedById], ['pending_review', null, null]);
      assert.deepEqual((await ledger(held.id)).map(({ kind }) => kind), ['payout_hold']);
    } finally {
      await db.$executeRaw`ALTER TABLE money_movements DROP CONSTRAINT payout_fixture_ledger_failure`;
    }
    await expect(approve(held.id), 200);
  });

  await t.test('a confirmed total at the safe limit remains readable and further holds can be rejected', async () => {
    const user = await marketer(maximum);
    const first = await expect(request(user, Number(maximum)), 201);
    await expect(approve(first.id), 200);
    const fixture = await saleFixture(user);
    await expect(fixture.redeem(fixture.pass), 201);
    const second = await expect(request(user, Number(commission)), 201);
    await expect(approve(second.id), 409, 'AMOUNT_OUT_OF_RANGE');
    await balance(user, 0n, commission);
    assert.deepEqual((await ledger(second.id)).map(({ kind }) => kind), ['payout_hold']);
    assert.equal((await walletApi(user)).totalConfirmedPaidOutSyp, Number(maximum));
    await expect(reject(second.id, 'Cumulative limit'), 200);
    await balance(user, commission, 0n);
  });

  await t.test('exact refund headroom allows one commission and rolls back a later overflowing sale', async () => {
    const user = await marketer(maximum - commission);
    const fixture = await saleFixture(user);
    const held = await expect(request(user, Number(maximum - commission)), 201);
    await expect(fixture.redeem(fixture.pass), 201);
    await balance(user, commission, maximum - commission);
    const secondPass = await fixture.createPass();
    const key = randomUUID();
    const snapshot = async () => ({
      campaign: await db.campaign.findUniqueOrThrow({ where: { id: fixture.campaign.id } }),
      marketerWallet: await wallet(user), customer: await fixture.cashback(), merchantWallet: await wallet(merchant, 'merchant'),
      saleCount: await db.sale.count(), moneyMovementCount: await db.moneyMovement.count(), revenue: await revenue(),
    });
    const before = await snapshot();
    await expect(fixture.redeem(secondPass, key), 409, 'AMOUNT_OUT_OF_RANGE');
    assert.deepEqual(await snapshot(), before);
    assert.equal(await storedKey(merchant, key), 0);
    assert.equal((await db.offerQrPass.findUniqueOrThrow({ where: { id: secondPass.id } })).status, 'active');
    await expect(reject(held.id, 'Refund at the exact limit'), 200);
    await balance(user, maximum, 0n);
  });

  await t.test('scanner commission serializes with approval and rejection under the same wallet lock', async () => {
    for (const decision of ['approve', 'reject']) {
      const start = decision === 'approve' ? maximum : maximum - commission;
      const user = await marketer(start);
      const fixture = await saleFixture(user, 1);
      const held = await expect(request(user, Number(start)), 201);
      const operation = () => decision === 'approve' ? approve(held.id) : reject(held.id, 'Concurrent refund');
      // Approval must win to free capacity. Rejection runs after an exact-limit commission.
      const settle = () => fixture.redeem(fixture.pass);
      const [first, second] = await race(user, decision === 'approve' ? operation : settle, decision === 'approve' ? settle : operation);
      const sale = await expect(decision === 'approve' ? second : first, 201);
      await expect(decision === 'approve' ? first : second, 200);
      assert.deepEqual([sale.marketerCommissionSyp, sale.customerCashbackSyp, sale.platformNetFeeSyp, sale.campaignStatusAfterSale],
        [10000, 1800, 2700, 'ended']);
      await balance(user, decision === 'approve' ? commission : maximum, 0n);
      assert.equal(await db.sale.count({ where: { campaignId: fixture.campaign.id } }), 1);
      assert.equal((await ledger(held.id)).length, 2);
    }
  });

  await t.test('OpenAPI declares the five authenticated operations and only the supported statuses', async () => {
    const response = await fetch(origin + '/api/docs-json', { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200);
    const swagger = await response.json();
    const paths = swagger.paths;
    const create = paths['/api/v1/marketer/payouts'].post;
    assert.ok(create.parameters.some(param => param.name === 'Idempotency-Key' && param.required));
    for (const operation of [create, paths['/api/v1/marketer/payouts'].get, paths['/api/v1/admin/payouts'].get,
      paths['/api/v1/admin/payouts/{payoutId}/approve'].patch, paths['/api/v1/admin/payouts/{payoutId}/reject'].patch]) {
      assert.deepEqual(operation.security, [{ bearer: [] }]);
    }
    assert.equal(paths['/api/v1/admin/payouts/{payoutId}/approve'].patch.requestBody, undefined);
    assert.deepEqual(swagger.components.schemas.PayoutDto.properties.status.enum, ['pending_review', 'confirmed', 'rejected']);
    assert.ok(paths['/api/v1/merchant/uploads/image'].post);
  });
});
