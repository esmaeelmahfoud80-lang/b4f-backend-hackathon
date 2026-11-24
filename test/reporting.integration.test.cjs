const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const test = require('node:test');
const { URL } = require('node:url');
const bcrypt = require('bcrypt');
const { AbortSignal } = globalThis;

const databaseUrl = process.env.REPORTING_INTEGRATION_DATABASE_URL;
const routes = {
  'merchant/wallet': 'MerchantWalletDto',
  'merchant/wallet/transactions': 'MerchantWalletTransactionPageDto',
  'merchant/dashboard': 'MerchantDashboardDto',
  'marketer/wallet': 'MarketerWalletDto',
  'marketer/wallet/by-merchant': 'MarketerMerchantEarningsPageDto',
  'marketer/wallet/transactions': 'MarketerWalletTransactionPageDto',
  'marketer/stats': 'MarketerStatsDto',
  'customer/dashboard': 'CustomerDashboardDto',
  'customer/purchases': 'CustomerPurchasePageDto',
};

test('Step 11C reporting against isolated PostgreSQL', { skip: !databaseUrl, timeout: 60000 }, async (t) => {
  const url = new URL(databaseUrl);
  assert.ok(['postgresql:', 'postgres:'].includes(url.protocol) && url.hostname === '127.0.0.1' &&
    /^\/affiliate_marketing_reporting_test_[a-z0-9_]+$/.test(url.pathname) && !url.search && !url.hash,
  'Expected a fresh loopback reporting test database');
  process.env.DATABASE_URL = databaseUrl;
  process.env.JWT_SECRET = randomBytes(32).toString('base64url');
  process.env.WEB_BASE_URL = 'https://demo.example.test';
  process.env.CASHBACK_MILESTONE_PURCHASES = '2';
  process.env.CASHBACK_MILESTONE_SPEND_SYP = '100000';

  const { createApp } = require('../dist/main');
  const { Prisma } = require('../dist/generated/prisma/client');
  const { PrismaService } = require('../dist/prisma/prisma.service');
  const app = await createApp({ logger: false });
  t.after(() => app.close());
  const db = app.get(PrismaService).getClient();
  const [identity] = await db.$queryRaw`SELECT current_database() AS db, host(inet_server_addr()) AS host`;
  assert.deepEqual(identity, { db: url.pathname.slice(1), host: '127.0.0.1' });
  assert.equal(await db.user.count(), 0, 'Expected a fresh database without users');
  assert.equal(await db.moneyMovement.count(), 0, 'Expected a fresh database without ledger entries');
  await app.listen(0, '127.0.0.1');
  const origin = await app.getUrl();

  function request(path, { method = 'GET', token, key, body } = {}) {
    return fetch(`${origin}/api/v1/${path}`, { method, headers: {
      ...(token && { authorization: `Bearer ${token}` }), ...(key && { 'Idempotency-Key': key }),
      ...(body !== undefined && { 'content-type': 'application/json' }),
    }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(8000) });
  }
  async function json(response, status) {
    assert.equal(response.status, status);
    return response.json();
  }
  const read = (path, token) => request(path, { token }).then((response) => {
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return json(response, 200);
  });
  const post = (path, { token, key, body } = {}) => request(path, { method: 'POST', token, key, body });
  const password = randomBytes(24).toString('base64url');
  const register = async (suffix, roles) => {
    const fields = { phone: `099921000${suffix}`, name: `Fixture ${suffix}`, roles, password,
      ...(roles.includes('merchant') && { shop: { name: `Fixture shop ${suffix}`, details: 'Fixture details' } }) };
    const session = await json(await post('auth/register', { body: fields }), 201);
    return { id: session.user.id, token: session.accessToken };
  };
  const multi = await register(1, ['merchant', 'marketer', 'customer']);
  const seller = await register(2, ['merchant']);
  const buyer = await register(3, ['customer']);
  const otherSeller = await register(4, ['merchant']);
  const otherMarketer = await register(5, ['marketer']);
  const marketerWithoutSales = await register(7, ['marketer']);
  const admin = await db.user.create({ data: { phone: '0999210006', name: 'Fixture admin',
    isAdmin: true, passwordHash: await bcrypt.hash(password, 10) } });
  const adminSession = await json(await post('auth/admin/login', { body: { phone: admin.phone, password } }), 200);
  const revenue = () => read('admin/revenue', adminSession.accessToken);
  const revenueSummary = () => read('admin/revenue/summary', adminSession.accessToken);
  const marketerEarnings = (query = '') => read(`admin/revenue/marketers${query}`, adminSession.accessToken);

  await t.test('platform revenue is zero without sales and requires an admin session', async () => {
    assert.deepEqual(await revenue(), { netPlatformFeesSyp: 0 });
    assert.deepEqual(await revenueSummary(), { netPlatformFeesSyp: 0, totalMarketerCommissionSyp: 0 });
    assert.equal((await json(await request('admin/revenue'), 401)).code, 'AUTH_REQUIRED');
    assert.equal((await json(await request('admin/revenue/summary'), 401)).code, 'AUTH_REQUIRED');
    assert.equal((await json(await request('admin/revenue/marketers'), 401)).code, 'AUTH_REQUIRED');
    assert.equal((await json(await request('admin/revenue', { token: 'invalid-token' }), 401)).code, 'AUTH_REQUIRED');
    for (const actor of [buyer, seller, otherMarketer, multi]) {
      assert.equal((await json(await request('admin/revenue', { token: actor.token }), 403)).code, 'FORBIDDEN');
      assert.equal((await json(await request('admin/revenue/summary', { token: actor.token }), 403)).code, 'FORBIDDEN');
      assert.equal((await json(await request('admin/revenue/marketers', { token: actor.token }), 403)).code, 'FORBIDDEN');
    }
    assert.equal((await json(await request('admin/revenue/marketers?pageSize=101', { token: adminSession.accessToken }), 400)).code,
      'VALIDATION_ERROR');
    const directory = await marketerEarnings();
    assert.equal(directory.total, 3);
    assert.ok(directory.items.every(({ salesCount, totalEarnedSyp }) => salesCount === 0 && totalEarnedSyp === 0));
  });

  await t.test('empty histories and independent reads for a pending multi-role merchant', async () => {
    const contents = await Promise.all(Object.keys(routes).map((route) => read(route, multi.token)));
    assert.deepEqual(contents[0], { availableBalanceSyp: 0, totalLockedReservesSyp: 0, creditLimitSyp: 0 });
    assert.equal(contents[2].verificationStatus, 'pending');
    assert.equal(contents[2].topCampaign, null);
    assert.equal(contents[2].stats.conversionRatePercent, 0);
    assert.deepEqual(contents[3], { availableBalanceSyp: 0, pendingPayoutSyp: 0, totalEarnedSyp: 0, totalConfirmedPaidOutSyp: 0 });
    assert.deepEqual(contents[6], { clicks: 0, itemsSold: 0, earnedSyp: 0, conversionRatePercent: 0 });
    assert.deepEqual(contents[7], { verifiedPurchaseCount: 0, milestonePurchaseCount: 0, milestonePurchasesRequired: 2,
      milestoneSpendSyp: 0, milestoneSpendRequiredSyp: 100000, lockedCashbackSyp: 0, availableCashbackSyp: 0, totalCashbackUnlockedSyp: 0 });
    for (const index of [1, 4, 5, 8]) {
      assert.deepEqual(contents[index], { items: [], page: 1, pageSize: 20, total: 0, previousPage: null, nextPage: null });
    }
  });

  async function launch(merchant, productName) {
    await json(await request(`admin/merchants/${merchant.id}/verification`, {
      method: 'PATCH', token: adminSession.accessToken, body: { status: 'verified' },
    }), 200);
    await json(await post(`admin/merchants/${merchant.id}/topups`, { token: adminSession.accessToken,
      key: randomUUID(), body: { paymentMethod: 'cash', amountSyp: 100000, referenceNote: 'Reporting fixture credit' } }), 201);
    return json(await post('merchant/campaigns', { token: merchant.token, key: randomUUID(), body: {
      campaignType: 'product', productName, description: 'Fixture product', imageUrl: 'https://demo.example.test/item.jpg',
      originalPriceSyp: 100000, discountPercent: 10, commission: { type: 'fixed', amountSyp: 10000 },
      maxItems: 3, joinMode: 'open', endsAt: new Date(Date.now() + 3600000).toISOString(),
    } }), 201);
  }
  const firstCampaign = await launch(seller, 'First shop product');
  const secondCampaign = await launch(otherSeller, 'Second shop product');
  async function join(marketer, campaign) {
    const membership = await json(await post(`marketer/campaigns/${campaign.id}/join`, { token: marketer.token }), 201);
    return new URL(membership.referralUrl).pathname.split('/').at(-1);
  }
  const firstCode = await join(multi, firstCampaign);
  const secondCode = await join(multi, secondCampaign);
  const otherCode = await join(otherMarketer, secondCampaign);
  for (const code of [firstCode, firstCode, firstCode, secondCode, otherCode]) {
    assert.equal((await post(`public/referrals/${code}/clicks`)).status, 204);
  }

  await t.test('top-ups, reserves, unused offers and rolled-back settlements do not contribute revenue', async () => {
    const expired = await json(await post(`customer/referrals/${firstCode}/offer-qr`, { token: buyer.token }), 201);
    await db.offerQrPass.update({ where: { passCode: expired.passCode }, data: { status: 'expired' } });
    const unused = await json(await post(`customer/referrals/${otherCode}/offer-qr`, { token: buyer.token }), 201);
    assert.deepEqual(await revenue(), { netPlatformFeesSyp: 0 });

    await db.$executeRaw`CREATE FUNCTION reporting_test_reject_fee() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.kind = 'platform_net_fee' THEN RAISE EXCEPTION 'Synthetic reporting ledger failure'; END IF;
        RETURN NEW;
      END;
    $$`;
    try {
      await db.$executeRaw`CREATE TRIGGER reporting_test_reject_fee BEFORE INSERT ON money_movements
        FOR EACH ROW EXECUTE FUNCTION reporting_test_reject_fee()`;
      const failed = await json(await post('merchant/scanner/redeem-offer', { token: otherSeller.token, key: randomUUID(),
        body: { code: unused.passCode } }), 500);
      assert.equal(failed.code, 'INTERNAL_ERROR');
      assert.equal(await db.sale.count(), 0);
      const pass = await db.offerQrPass.findUniqueOrThrow({ where: { passCode: unused.passCode } });
      assert.equal(pass.status, 'active');
      assert.deepEqual(await revenue(), { netPlatformFeesSyp: 0 });
    } finally {
      await db.$executeRaw`DROP TRIGGER IF EXISTS reporting_test_reject_fee ON money_movements`;
      await db.$executeRaw`DROP FUNCTION reporting_test_reject_fee()`;
    }
  });

  async function settle(customer, merchant, code, repeat = false) {
    const pass = await json(await post(`customer/referrals/${code}/offer-qr`, { token: customer.token }), 201);
    const redeem = (key) => post('merchant/scanner/redeem-offer', { token: merchant.token, key, body: { code: pass.passCode } });
    const key = randomUUID();
    const sale = await json(await redeem(key), 201);
    if (repeat) {
      assert.deepEqual(await revenue(), { netPlatformFeesSyp: 2700 });
      assert.deepEqual(await json(await redeem(key), 201), sale);
      assert.equal((await json(await redeem(randomUUID()), 409)).code, 'QR_ALREADY_REDEEMED');
      assert.deepEqual(await revenue(), { netPlatformFeesSyp: 2700 });
    }
    return sale;
  }
  await settle(buyer, seller, firstCode, true);
  await settle(buyer, seller, firstCode);
  await settle(buyer, otherSeller, secondCode);
  await settle(multi, otherSeller, otherCode);
  assert.equal((await json(await post(`customer/referrals/${secondCode}/offer-qr`, { token: multi.token }), 403)).code,
    'SELF_PROMOTION_FORBIDDEN');

  // Tie two merchant ledger timestamps so pagination must use the ID tie-breaker.
  await db.moneyMovement.updateMany({ where: { campaignId: firstCampaign.id, kind: 'sale_reserve_debit' },
    data: { createdAt: new Date() } });
  // Compare all rows without exposing stored credentials or tokens on assertion failures.
  const tables = ['users', 'user_sessions', 'wallets', 'merchant_profiles', 'customer_profiles',
    'merchant_topups', 'campaigns', 'campaign_marketers', 'referral_clicks', 'offer_qr_passes',
    'sales', 'money_movements', 'idempotency_records'];
  const snapshot = () => db.$transaction(tables.map((table) =>
    db.$queryRaw`SELECT md5(COALESCE(string_agg(row_data, E'\\n' ORDER BY row_data), '')) AS digest
      FROM (SELECT to_jsonb(r)::text AS row_data FROM ${Prisma.raw(table)} r) AS table_rows`));
  const before = await snapshot();

  await t.test('platform revenue adds settled sales from both merchants without writing data', async () => {
    assert.deepEqual(await revenue(), { netPlatformFeesSyp: 10800 });
    assert.deepEqual(await revenueSummary(), { netPlatformFeesSyp: 10800, totalMarketerCommissionSyp: 40000 });
    const first = await marketerEarnings('?pageSize=2');
    const second = await marketerEarnings('?pageSize=2&page=2');
    assert.deepEqual([first.total, first.nextPage, second.previousPage, second.nextPage], [3, 2, 1, null]);
    assert.deepEqual([...first.items, ...second.items], [
      { id: marketerWithoutSales.id, name: 'Fixture 7', phone: '0999210007', salesCount: 0, totalEarnedSyp: 0 },
      { id: otherMarketer.id, name: 'Fixture 5', phone: '0999210005', salesCount: 1, totalEarnedSyp: 10000 },
      { id: multi.id, name: 'Fixture 1', phone: '0999210001', salesCount: 3, totalEarnedSyp: 30000 },
    ]);
    assert.deepEqual((await marketerEarnings('?pageSize=2&page=3')).items, []);
    assert.deepEqual(await snapshot(), before);
  });

  await t.test('merchant wallet, campaign reserves, statistics and ledger reconcile', async () => {
    const wallet = await read('merchant/wallet', seller.token);
    assert.deepEqual(wallet, { availableBalanceSyp: 56500, totalLockedReservesSyp: 14500, creditLimitSyp: 0 });
    assert.deepEqual(await read('merchant/dashboard', seller.token), {
      verificationStatus: 'verified', wallet, activeCampaignsCount: 1,
      topCampaign: { campaignId: firstCampaign.id, productName: 'First shop product', grossCashSalesSyp: 180000, salesCount: 2 },
      stats: { clicks: 3, salesCount: 2, itemsSold: 2, grossCashSalesSyp: 180000, commissionPaidSyp: 20000,
        platformFeesPaidSyp: 9000, conversionRatePercent: 66.67 },
    });
    const page1 = await read('merchant/wallet/transactions?pageSize=2', seller.token);
    const page2 = await read('merchant/wallet/transactions?pageSize=2&page=2', seller.token);
    assert.deepEqual([page1.total, page1.nextPage, page2.previousPage, page2.nextPage], [4, 2, 1, null]);
    const items = [...page1.items, ...page2.items];
    const rows = await db.moneyMovement.findMany({ where: { OR: [{ campaignId: firstCampaign.id,
      kind: { in: ['sale_reserve_debit', 'campaign_reserve_lock'] } }, { kind: 'merchant_topup', topup: { merchantId: seller.id } }] },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    assert.deepEqual(items.map(({ id }) => id), rows.map(({ id }) => id));
    assert.deepEqual(items.filter(({ kind }) => kind === 'sale_reserve_debit').map(({ amountSyp }) => amountSyp), [14500, 14500]);
    assert.deepEqual(items.filter(({ kind }) => kind === 'merchant_topup').map(({ amountSyp, referenceNote, campaignId }) =>
      ({ amountSyp, referenceNote, campaignId })), [{ amountSyp: 100000, referenceNote: 'Reporting fixture credit', campaignId: null }]);
    assert.equal((await read('merchant/dashboard', multi.token)).verificationStatus, 'pending');
    assert.equal((await read('merchant/wallet', multi.token)).availableBalanceSyp, 0);
  });

  await t.test('marketer wallet, grouped earnings, commission ledger and clicks stay scoped to the actor', async () => {
    assert.deepEqual(await read('marketer/wallet', multi.token), {
      availableBalanceSyp: 30000, pendingPayoutSyp: 0, totalEarnedSyp: 30000, totalConfirmedPaidOutSyp: 0,
    });
    assert.deepEqual(await read('marketer/stats', multi.token), {
      clicks: 4, itemsSold: 3, earnedSyp: 30000, conversionRatePercent: 75,
    });
    const first = await read('marketer/wallet/by-merchant?pageSize=1', multi.token);
    const second = await read('marketer/wallet/by-merchant?pageSize=1&page=2', multi.token);
    assert.deepEqual([first.total, first.nextPage, second.previousPage], [2, 2, 1]);
    assert.deepEqual([...first.items, ...second.items], [
      { merchantId: seller.id, shopName: 'Fixture shop 2', salesCount: 2, itemsSold: 2, totalEarnedSyp: 20000 },
      { merchantId: otherSeller.id, shopName: 'Fixture shop 4', salesCount: 1, itemsSold: 1, totalEarnedSyp: 10000 },
    ]);
    const ledger = await read('marketer/wallet/transactions', multi.token);
    assert.equal(ledger.total, 3);
    assert.ok(ledger.items.every(({ kind, amountSyp }) => kind === 'marketer_commission_credit' && amountSyp === 10000));
    assert.deepEqual(new Set(ledger.items.map(({ shopName }) => shopName)), new Set(['Fixture shop 2', 'Fixture shop 4']));
    assert.equal((await read('marketer/wallet', otherMarketer.token)).totalEarnedSyp, 10000);
  });

  await t.test('customer dashboard reconciles lifetime unlocks and purchase history without exposing credentials', async () => {
    assert.deepEqual(await read('customer/dashboard', buyer.token), {
      verifiedPurchaseCount: 3, milestonePurchaseCount: 1, milestonePurchasesRequired: 2,
      milestoneSpendSyp: 90000, milestoneSpendRequiredSyp: 100000,
      lockedCashbackSyp: 1800, availableCashbackSyp: 3600, totalCashbackUnlockedSyp: 3600,
    });
    const multiDashboard = await read('customer/dashboard', multi.token);
    assert.equal(multiDashboard.verifiedPurchaseCount, 1);
    assert.equal(multiDashboard.lockedCashbackSyp, 1800);
    assert.equal(multiDashboard.totalCashbackUnlockedSyp, 0);
    const page = await read('customer/purchases?pageSize=2', buyer.token);
    const next = await read('customer/purchases?pageSize=2&page=2', buyer.token);
    const rows = await db.sale.findMany({ where: { customerId: buyer.id }, orderBy: [{ scannedAt: 'desc' }, { id: 'desc' }] });
    assert.equal(page.total, 3);
    assert.equal(page.nextPage, 2);
    const purchased = [...page.items, ...next.items];
    assert.deepEqual(purchased.map(({ saleId }) => saleId), rows.map(({ id }) => id));
    assert.ok(purchased.every(({ customerPaidCashSyp, cashbackEarnedSyp, quantity }) =>
      customerPaidCashSyp === 90000 && cashbackEarnedSyp === 1800 && quantity === 1));
    assert.deepEqual(Object.keys(purchased[0]).sort(),
      ['cashbackEarnedSyp', 'customerPaidCashSyp', 'productName', 'quantity', 'saleId', 'scannedAt', 'shopName']);
    const isolated = await read('customer/purchases', multi.token);
    assert.equal(isolated.total, 1);
    assert.ok(!purchased.some((item) => item.saleId === isolated.items[0].saleId));
  });

  await t.test('all routes enforce role, validate page input and make no database writes', async () => {
    for (const path of Object.keys(routes)) {
      assert.equal((await json(await request(path), 401)).code, 'AUTH_REQUIRED');
      const wrongRole = path.startsWith('customer/') ? seller : buyer;
      assert.equal((await json(await request(path, { token: wrongRole.token }), 403)).code, 'FORBIDDEN');
      if (routes[path].endsWith('PageDto')) {
        assert.equal((await json(await request(`${path}?page=0`, { token: multi.token }), 400)).code, 'VALIDATION_ERROR');
        assert.equal((await json(await request(`${path}?userId=${seller.id}`, { token: multi.token }), 400)).code, 'VALIDATION_ERROR');
      }
    }
    assert.deepEqual(await snapshot(), before);
  });

  await t.test('Swagger exposes all nine role-protected DTOs and new SYP units', async () => {
    const docs = await json(await fetch(`${origin}/api/docs-json`, { signal: AbortSignal.timeout(5000) }), 200);
    for (const [path, dto] of Object.entries(routes)) {
      const route = docs.paths[`/api/v1/${path}`].get;
      assert.deepEqual(route.security, [{ bearer: [] }]);
      assert.equal(route.responses['200'].content['application/json'].schema.$ref, `#/components/schemas/${dto}`);
      assert.match(route.responses['403'].description, /FORBIDDEN/);
      assert.match(route.responses['409'].description, /AMOUNT_OUT_OF_RANGE/);
      if (dto.endsWith('PageDto')) {
        assert.deepEqual(route.parameters.map(({ name }) => name).sort(), ['page', 'pageSize']);
        assert.match(route.responses['400'].description, /VALIDATION_ERROR/);
      }
    }
    const schemas = docs.components.schemas;
    assert.match(schemas.MerchantWalletDto.properties.totalLockedReservesSyp.description, /hundredths of one new Syrian Pound/);
    assert.equal(schemas.MarketerWalletDto.properties.totalConfirmedPaidOutSyp.type, 'integer');
    assert.equal(schemas.CustomerPurchasePageDto.properties.items.items.$ref, '#/components/schemas/CustomerPurchaseDto');

    const revenueRoute = docs.paths['/api/v1/admin/revenue'].get;
    assert.deepEqual(revenueRoute.security, [{ bearer: [] }]);
    assert.equal(revenueRoute.responses['200'].content['application/json'].schema.$ref, '#/components/schemas/AdminRevenueDto');
    assert.deepEqual(revenueRoute.responses['200'].headers['Cache-Control'].schema.enum, ['no-store']);
    assert.match(revenueRoute.responses['401'].description, /AUTH_REQUIRED.*SESSION_EXPIRED/);
    assert.equal(revenueRoute.responses['403'].description, 'FORBIDDEN');
    assert.equal(revenueRoute.responses['409'].description, 'AMOUNT_OUT_OF_RANGE');
    assert.equal(revenueRoute.responses['500'].description, 'INTERNAL_ERROR');
    const revenueSchema = schemas.AdminRevenueDto;
    assert.deepEqual(revenueSchema.required, ['netPlatformFeesSyp']);
    assert.deepEqual(Object.keys(revenueSchema.properties), ['netPlatformFeesSyp']);
    const fees = revenueSchema.properties.netPlatformFeesSyp;
    assert.equal(fees.type, 'integer');
    assert.equal(fees.minimum, 0);
    assert.equal(fees.maximum, Number.MAX_SAFE_INTEGER);
    assert.match(fees.description, /hundredths of one new Syrian Pound/);
  });

  await t.test('platform revenue rejects a sum outside the safe integer range', async () => {
    // Use a synthetic, split-consistent boundary value in this disposable database.
    const sale = await db.sale.findFirstOrThrow();
    const limit = BigInt(Number.MAX_SAFE_INTEGER);
    try {
      await db.sale.update({ where: { id: sale.id }, data: {
        platformNetFeeSyp: limit, platformTotalFeeSyp: limit, totalDeductedReserveSyp: limit,
        customerCashbackSyp: 0n, marketerCommissionSyp: 0n,
      } });
      assert.equal((await json(await request('admin/revenue', { token: adminSession.accessToken }), 409)).code,
        'AMOUNT_OUT_OF_RANGE');
    } finally {
      const { platformNetFeeSyp, platformTotalFeeSyp, totalDeductedReserveSyp, customerCashbackSyp, marketerCommissionSyp } = sale;
      await db.sale.update({ where: { id: sale.id }, data: {
        platformNetFeeSyp, platformTotalFeeSyp, totalDeductedReserveSyp, customerCashbackSyp, marketerCommissionSyp,
      } });
    }
  });
});
