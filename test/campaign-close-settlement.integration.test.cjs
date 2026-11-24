const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const test = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { URL } = require('node:url');
const bcrypt = require('bcrypt');
const { Client } = require('pg');

const { AbortSignal } = globalThis;
const databaseUrl = process.env.CAMPAIGN_CLOSE_SETTLEMENT_INTEGRATION_DATABASE_URL;

// Amounts are integer minor units of the new Syrian Pound.
const openingBalance = 500000n;
const originalPrice = 100000n;
const discount = 10n;
const commission = 10000n;
const maxItems = 30n;
const cash = originalPrice * (100n - discount) / 100n;
const fee = cash * 5n / 100n;
const cashback = cash * 2n / 100n;
const netFee = fee - cashback;
const debit = commission + fee;
const reserve = debit * maxItems;

async function waitForCampaignWaiter(db, gatePid, firstPid = gatePid) {
  const deadline = Date.now() + 2000;
  do {
    const rows = await db.$queryRaw`
      SELECT pid FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'
        AND pid <> ${firstPid}::int
        AND pg_blocking_pids(pid) && ARRAY[${gatePid}::int, ${firstPid}::int]
        AND query LIKE '%SELECT id FROM campaigns WHERE id =%FOR UPDATE%'
    `;
    if (rows.length) return rows[0].pid;
    await delay(15);
  } while (Date.now() < deadline);
  assert.fail('Expected an API transaction to wait for the campaign row lock');
}

test('TG-01 manual close racing Offer QR settlement on isolated PostgreSQL', { skip: !databaseUrl, timeout: 60000 }, async (t) => {
  const url = new URL(databaseUrl);
  assert.ok(['postgresql:', 'postgres:'].includes(url.protocol) && url.hostname === '127.0.0.1' &&
    /^\/affiliate_marketing_close_settle_test_[a-z0-9_]+$/.test(url.pathname) && !url.search && !url.hash,
  'Expected a dedicated loopback closure and settlement test database');
  Object.assign(process.env, {
    NODE_ENV: 'test', DATABASE_URL: databaseUrl, JWT_SECRET: randomBytes(32).toString('base64url'),
    WEB_BASE_URL: 'https://demo.example.test', CASHBACK_MILESTONE_PURCHASES: '5', CASHBACK_MILESTONE_SPEND_SYP: '50000',
  });
  const { createApp } = require('../dist/main');
  const { PrismaService } = require('../dist/prisma/prisma.service');
  const app = await createApp({ logger: false });
  t.after(() => app.close());
  const db = app.get(PrismaService).getClient();
  const [identity] = await db.$queryRaw`SELECT current_database() AS db, host(inet_server_addr()) AS host`;
  assert.deepEqual(identity, { db: url.pathname.slice(1), host: '127.0.0.1' });
  const [initial] = await db.$queryRaw`SELECT (SELECT count(*) FROM users) AS users, (SELECT count(*) FROM campaigns) AS campaigns,
    (SELECT count(*) FROM sales) AS sales, (SELECT count(*) FROM money_movements) AS movements,
    (SELECT count(*) FROM idempotency_records) AS receipts`;
  assert.deepEqual(initial, { users: 0n, campaigns: 0n, sales: 0n, movements: 0n, receipts: 0n });

  const blocker = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 3000, statement_timeout: 3000 });
  t.after(() => blocker.end());
  await blocker.connect();
  const { rows: [gate] } = await blocker.query('SELECT current_database() AS db, host(inet_server_addr()) AS host, pg_backend_pid() AS pid');
  assert.deepEqual({ db: gate.db, host: gate.host }, identity);

  await app.listen(0, '127.0.0.1');
  const base = `${await app.getUrl()}/api/v1`;
  async function request(method, path, { token, key, body } = {}) {
    const response = await fetch(`${base}/${path}`, {
      method, headers: { ...(token && { authorization: `Bearer ${token}` }), ...(key && { 'Idempotency-Key': key }),
        ...(body !== undefined && { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(8000),
    });
    return { status: response.status, body: await response.json() };
  }
  async function expect(response, status) {
    const result = await response;
    assert.equal(result.status, status, result.body.code);
    return result.body;
  }
  const password = randomBytes(24).toString('base64url');
  const passwordHash = await bcrypt.hash(password, 10);
  let nextPhone = 0;
  const user = (data) => db.user.create({ data: {
    name: 'TG-01 fixture', phone: `099961${String(++nextPhone).padStart(4, '0')}`, passwordHash, ...data,
  } });
  const login = async (account, path) => (await expect(request('POST', path, { body: { phone: account.phone, password } }), 200)).accessToken;
  const admin = await login(await user({ isAdmin: true }), 'auth/admin/login');
  const revenue = async () => (await expect(request('GET', 'admin/revenue', { token: admin }), 200)).netPlatformFeesSyp;

  async function fixture() {
    const merchant = await user({ merchantProfile: { create: { shopName: 'Fixture shop', shopDetails: 'Fixture details', verificationStatus: 'verified' } },
      wallets: { create: { role: 'merchant' } } });
    const marketer = await user({ isMarketer: true, wallets: { create: { role: 'marketer' } } });
    const customer = await user({ isCustomer: true, customerProfile: { create: {} } });
    const funded = await expect(request('POST', `admin/merchants/${merchant.id}/topups`, { token: admin, key: randomUUID(),
      body: { amountSyp: Number(openingBalance), referenceNote: 'TG-01 fixture', paymentMethod: 'cash' } }), 201);
    assert.equal(funded.merchantNewAvailableBalanceSyp, Number(openingBalance));

    const token = await login(merchant, 'auth/login');
    const campaign = await expect(request('POST', 'merchant/campaigns', { token, key: randomUUID(), body: {
      campaignType: 'product', productName: 'TG-01 product', description: 'Fixture product', imageUrl: 'https://demo.example.test/item.jpg',
      originalPriceSyp: Number(originalPrice), discountPercent: Number(discount), commission: { type: 'fixed', amountSyp: Number(commission) },
      maxItems: Number(maxItems), joinMode: 'open', endsAt: new Date(Date.now() + 3600000).toISOString(),
    } }), 201);
    assert.equal(campaign.usage.lockedBudgetSyp, Number(reserve));
    const membership = await db.campaignMarketer.create({ data: { campaignId: campaign.id, marketerId: marketer.id, status: 'approved' } });
    const pass = await db.offerQrPass.create({ data: { campaignId: campaign.id, customerId: customer.id, campaignMarketerId: membership.id,
      qrToken: randomBytes(32).toString('base64url'), passCode: `OF-${randomBytes(6).toString('hex').toUpperCase()}` } });
    return { token, campaignId: campaign.id, merchantId: merchant.id, marketerId: marketer.id, customerId: customer.id,
      topupId: funded.topupId, pass };
  }

  async function race(campaignId, first, second) {
    const requests = [];
    await blocker.query('BEGIN');
    try {
      // Hold the row while both HTTP transactions queue for it in an observed order.
      const lock = await blocker.query('SELECT id FROM campaigns WHERE id = $1::uuid FOR UPDATE', [campaignId]);
      assert.equal(lock.rowCount, 1);
      requests.push(Promise.allSettled([first()]));
      const firstPid = await waitForCampaignWaiter(db, gate.pid);
      requests.push(Promise.allSettled([second()]));
      await waitForCampaignWaiter(db, gate.pid, firstPid);
    } finally {
      await blocker.query('ROLLBACK').finally(() => Promise.all(requests));
    }
    return (await Promise.all(requests)).map(([result]) => {
      if (result.status === 'rejected') throw result.reason;
      return result.value;
    });
  }

  async function reconcile(item, saleId) {
    const settled = Boolean(saleId);
    const available = settled ? openingBalance - debit : openingBalance;
    const campaign = await db.campaign.findUniqueOrThrow({ where: { id: item.campaignId } });
    assert.deepEqual([campaign.status, campaign.lockedBudgetSyp], ['ended', 0n]);
    assert.ok(campaign.closedAt);
    const pass = await db.offerQrPass.findUniqueOrThrow({ where: { id: item.pass.id } });
    assert.equal(pass.status, settled ? 'redeemed' : 'expired');
    const sales = await db.sale.findMany({ where: { campaignId: item.campaignId } });
    assert.equal(sales.length, settled ? 1 : 0);
    if (settled) {
      const [sale] = sales;
      assert.deepEqual([sale.id, sale.offerQrPassId, sale.customerPaidCashSyp, sale.marketerCommissionSyp,
        sale.customerCashbackSyp, sale.platformTotalFeeSyp, sale.platformNetFeeSyp, sale.totalDeductedReserveSyp],
      [saleId, item.pass.id, cash, commission, cashback, fee, netFee, debit]);
    }

    const merchant = await db.wallet.findUniqueOrThrow({ where: { userId_role: { userId: item.merchantId, role: 'merchant' } } });
    const marketer = await db.wallet.findUniqueOrThrow({ where: { userId_role: { userId: item.marketerId, role: 'marketer' } } });
    const customer = await db.customerProfile.findUniqueOrThrow({ where: { userId: item.customerId } });
    assert.deepEqual([merchant.availableBalanceSyp, merchant.pendingPayoutSyp, marketer.availableBalanceSyp, marketer.pendingPayoutSyp,
      customer.lockedCashbackSyp, customer.availableCashbackSyp, customer.milestoneSpendSyp,
      customer.verifiedPurchaseCount, customer.milestonePurchaseCount],
    [available, 0n, settled ? commission : 0n, 0n, settled ? cashback : 0n, 0n, settled ? cash : 0n,
      Number(settled), Number(settled)]);

    const movements = await db.moneyMovement.findMany({ where: { OR: [{ campaignId: item.campaignId }, { walletId: merchant.id },
      { walletId: marketer.id }, { customerId: item.customerId }] } });
    const expected = [
      { kind: 'merchant_topup', amountSyp: openingBalance, walletId: merchant.id, topupId: item.topupId },
      { kind: 'campaign_reserve_lock', amountSyp: reserve, walletId: merchant.id, campaignId: item.campaignId },
      { kind: 'campaign_reserve_unlock', amountSyp: settled ? reserve - debit : reserve, walletId: merchant.id, campaignId: item.campaignId },
    ];
    if (settled) {
      const source = { saleId, campaignId: item.campaignId };
      expected.push({ ...source, kind: 'sale_reserve_debit', amountSyp: debit },
        { ...source, kind: 'marketer_commission_credit', amountSyp: commission, walletId: marketer.id },
        { ...source, kind: 'customer_cashback_accrual', amountSyp: cashback, customerId: item.customerId },
        { ...source, kind: 'platform_net_fee', amountSyp: netFee });
    }
    const orderedReferences = (rows) => rows.map(({ kind, amountSyp, walletId = null, campaignId = null, saleId = null,
      topupId = null, customerId = null }) => ({ kind, amountSyp, walletId, campaignId, saleId, topupId, customerId }))
      .sort((a, b) => a.kind.localeCompare(b.kind));
    assert.deepEqual(orderedReferences(movements), orderedReferences(expected));
    const amount = (kind) => movements.find((entry) => entry.kind === kind)?.amountSyp ?? 0n;
    assert.equal(merchant.availableBalanceSyp, amount('merchant_topup') - amount('campaign_reserve_lock') + amount('campaign_reserve_unlock'));
    assert.equal(campaign.lockedBudgetSyp, amount('campaign_reserve_lock') - amount('sale_reserve_debit') - amount('campaign_reserve_unlock'));
    assert.equal(amount('sale_reserve_debit'), amount('marketer_commission_credit') + amount('customer_cashback_accrual') + amount('platform_net_fee'));
  }

  async function exercise(settlementFirst) {
    const item = await fixture();
    const beforeRevenue = await revenue();
    const key = randomUUID();
    const redeem = () => request('POST', 'merchant/scanner/redeem-offer', { token: item.token, key, body: { code: item.pass.passCode } });
    const close = () => request('POST', `merchant/campaigns/${item.campaignId}/close`, { token: item.token });
    const [first, second] = await race(item.campaignId, ...(settlementFirst ? [redeem, close] : [close, redeem]));
    const [sale, closure] = settlementFirst ? [first, second] : [second, first];
    await expect(closure, 200);
    assert.deepEqual([closure.body.status, closure.body.usage.lockedBudgetSyp], ['ended', 0]);

    if (settlementFirst) {
      await expect(sale, 201);
      assert.deepEqual([sale.body.campaignStatusAfterSale, sale.body.remainingLockedBudgetSyp], ['active', Number(reserve - debit)]);
      await reconcile(item, sale.body.saleId);
      assert.deepEqual(await redeem(), sale);
      await reconcile(item, sale.body.saleId);
    } else {
      await expect(sale, 409);
      assert.equal(sale.body.code, 'QR_EXPIRED');
      await reconcile(item);
    }
    assert.equal(await db.idempotencyRecord.count({ where: { actorId: item.merchantId, requestKey: key } }), Number(settlementFirst));
    assert.equal(await revenue(), beforeRevenue + (settlementFirst ? Number(netFee) : 0));
  }

  await t.test('settlement first commits one sale and replays its original receipt after closure', () => exercise(true));
  await t.test('closure first expires the pass and releases the entire reserve once', () => exercise(false));
  await t.test('four independent races reconcile across both acquisition orders', async () => {
    for (const settlementFirst of [false, true, false, true]) await exercise(settlementFirst);
  });
});
