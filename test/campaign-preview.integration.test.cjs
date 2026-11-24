const assert = require('node:assert/strict');
const test = require('node:test');
const { randomBytes } = require('node:crypto');
const { URL } = require('node:url');
const bcrypt = require('bcrypt');

const databaseUrl = process.env.CAMPAIGN_PREVIEW_INTEGRATION_DATABASE_URL;

test('Step 06 campaign preview HTTP and PostgreSQL integration', { skip: !databaseUrl }, async (t) => {
  const url = new URL(databaseUrl);
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol) &&
    ['127.0.0.1', '[::1]'].includes(url.hostname) &&
    /^\/affiliate_marketing_preview_test_[a-z0-9_]+$/.test(url.pathname) &&
    !url.search && !url.hash, 'Expected a dedicated loopback campaign-preview test database');

  process.env.JWT_SECRET = randomBytes(32).toString('base64url');
  process.env.DATABASE_URL = databaseUrl;
  const { createApp } = require('../dist/main');
  const { PrismaService } = require('../dist/prisma/prisma.service');
  const app = await createApp({ logger: false });
  t.after(() => app.close());
  const db = app.get(PrismaService).getClient();
  const [identity] = await db.$queryRaw`SELECT current_database() AS db, host(inet_server_addr()) AS host`;
  assert.equal(identity.db, url.pathname.slice(1));
  assert.ok(['127.0.0.1', '::1'].includes(identity.host));
  assert.equal(await db.user.count(), 0, 'Expected a fresh database without users');

  const password = randomBytes(24).toString('base64url');
  const passwordHash = await bcrypt.hash(password, 10);
  const merchant = (suffix, verificationStatus, availableBalanceSyp) => db.user.create({ data: {
    phone: `099916000${suffix}`, name: 'Preview fixture merchant', passwordHash,
    merchantProfile: { create: { shopName: 'Fixture shop', shopDetails: 'Fixture details', verificationStatus } },
    wallets: { create: { role: 'merchant', availableBalanceSyp } },
  } });
  const [verified, pending, customer] = await Promise.all([
    merchant(1, 'verified', 435000n), merchant(2, 'pending', 100000n),
    db.user.create({ data: { phone: '0999160003', name: 'Preview fixture customer', passwordHash, isCustomer: true,
      customerProfile: { create: {} } } }),
  ]);
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  const post = (path, body, token) => fetch(`${base}/api/v1/${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const login = async (user) => {
    const response = await post('auth/login', { phone: user.phone, password });
    assert.equal(response.status, 200);
    return (await response.json()).accessToken;
  };
  const [verifiedToken, pendingToken, customerToken] = await Promise.all([login(verified), login(pending), login(customer)]);
  const snapshot = () => db.$transaction([
    db.wallet.findMany({ orderBy: { id: 'asc' } }), db.campaign.findMany({ orderBy: { id: 'asc' } }),
    db.moneyMovement.findMany({ orderBy: { id: 'asc' } }), db.idempotencyRecord.count(),
    db.userSession.findMany({ orderBy: { id: 'asc' } }), db.merchantProfile.findMany({ orderBy: { userId: 'asc' } }),
    db.sale.count(), db.merchantTopup.count(),
  ]);
  const initial = await snapshot();
  const body = { campaignType: 'product', originalPriceSyp: 100000, discountPercent: 10,
    commission: { type: 'fixed', amountSyp: 10000 }, maxItems: 30 };
  const preview = (token, input = body) => post('merchant/campaigns/preview', input, token);
  const expectError = async (response, status, code) => {
    assert.equal(response.status, status);
    const payload = await response.json();
    assert.equal(payload.statusCode, status);
    assert.equal(payload.code, code);
    assert.equal(typeof payload.message, 'string');
  };

  await t.test('returns the full preview and actor-owned balance when reserve coverage is exact', async () => {
    const response = await preview(verifiedToken);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), {
      finalPriceSyp: 90000, sampleSaleAmountSyp: 90000, commissionPerUnitSyp: 10000,
      platformTotalFeeSampleSyp: 4500, customerCashbackSampleSyp: 1800, platformNetFeeSampleSyp: 2700,
      merchantNetSampleSyp: 75500, worstCaseReserveSyp: 435000, isAffordableByMerchant: true,
      merchantAvailableBalanceSyp: 435000,
    });
  });

  await t.test('pending merchant can preview and insufficient coverage is a repeatable 200', async () => {
    const first = await preview(pendingToken);
    assert.equal(first.status, 200);
    const result = await first.json();
    assert.equal(result.merchantAvailableBalanceSyp, 100000);
    assert.equal(result.worstCaseReserveSyp, 435000);
    assert.equal(result.isAffordableByMerchant, false);
    const again = await preview(pendingToken);
    assert.equal(again.status, 200);
    assert.deepEqual(await again.json(), result);
  });

  await t.test('requires authentication and merchant role backed by a current profile', async () => {
    await expectError(await preview(undefined), 401, 'AUTH_REQUIRED');
    await expectError(await preview(customerToken), 403, 'FORBIDDEN');
    assert.equal(await db.merchantProfile.count({ where: { userId: customer.id } }), 0);
  });

  await t.test('rejects invalid and unsupported inputs, including client-supplied merchant identity or balance', async () => {
    for (const overrides of [
      { commission: undefined }, { commission: null }, { commission: { type: 'fixed' } },
      { commission: { type: 'percentage', percent: 5 } }, { commission: { type: 'fixed', amountSyp: 85500 } },
      { commission: { type: 'fixed', amountSyp: -1 } }, { originalPriceSyp: 0 }, { originalPriceSyp: -1 },
      { originalPriceSyp: Number.MAX_SAFE_INTEGER + 1 }, { originalPriceSyp: '100000' },
      { discountPercent: 1e-7 }, { discountPercent: 100 }, { discountPercent: -1 },
      { maxItems: 0 }, { maxItems: 2147483648 }, { maxItems: 1.5 },
      { campaignType: 'store_discount', maxSalesVolumeSyp: 100000 },
      { merchantId: pending.id }, { merchantAvailableBalanceSyp: 900000 },
    ]) {
      await expectError(await preview(verifiedToken, { ...body, ...overrides }), 400, 'VALIDATION_ERROR');
    }
  });

  await t.test('applies the exact contract monetary boundary', async () => {
    const boundary = { ...body, originalPriceSyp: Number.MAX_SAFE_INTEGER, discountPercent: 0,
      commission: { type: 'fixed', amountSyp: 0 } };
    const response = await preview(verifiedToken, { ...boundary, maxItems: 20 });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).worstCaseReserveSyp, 9007199254740980);
    await expectError(await preview(verifiedToken, { ...boundary, maxItems: 21 }), 409, 'AMOUNT_OUT_OF_RANGE');
  });

  await t.test('Swagger publishes the preview DTOs, Bearer auth, error codes and minor-unit schema', async () => {
    const response = await fetch(`${base}/api/docs-json`);
    assert.equal(response.status, 200);
    const docs = await response.json();
    const path = docs.paths['/api/v1/merchant/campaigns/preview'].post;
    assert.deepEqual(path.security, [{ bearer: [] }]);
    assert.equal(path.requestBody.content['application/json'].schema.$ref, '#/components/schemas/CampaignPreviewInputDto');
    assert.equal(path.responses['200'].content['application/json'].schema.$ref, '#/components/schemas/CampaignPreviewDto');
    assert.equal(path.responses['400'].description, 'VALIDATION_ERROR');
    assert.equal(path.responses['409'].description, 'AMOUNT_OUT_OF_RANGE');
    for (const status of ['401', '403', '500']) assert.ok(path.responses[status]);
    const { CampaignPreviewInputDto, CampaignPreviewDto } = docs.components.schemas;
    assert.deepEqual(CampaignPreviewInputDto.required.slice().sort(), ['campaignType', 'commission', 'discountPercent', 'maxItems', 'originalPriceSyp']);
    for (const field of [CampaignPreviewInputDto.properties.originalPriceSyp, CampaignPreviewDto.properties.worstCaseReserveSyp]) {
      assert.equal(field.type, 'integer');
      assert.equal(field.maximum, Number.MAX_SAFE_INTEGER);
      assert.match(field.description, /hundredths of one new Syrian Pound/);
    }
  });

  await t.test('previews and failed requests leave PostgreSQL financial and session state unchanged', async () => {
    assert.deepEqual(await snapshot(), initial);
  });
});
