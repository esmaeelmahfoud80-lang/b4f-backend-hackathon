const assert = require('node:assert/strict');
const test = require('node:test');
const { randomBytes, randomUUID } = require('node:crypto');
const { URL } = require('node:url');
const bcrypt = require('bcrypt');

const { AbortSignal } = globalThis;
const databaseUrl = process.env.CAMPAIGN_MANAGEMENT_INTEGRATION_DATABASE_URL;

test('Step 07 campaign management on isolated PostgreSQL', { skip: !databaseUrl, timeout: 30000 }, async (t) => {
  const url = new URL(databaseUrl);
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol) &&
    ['127.0.0.1', '[::1]'].includes(url.hostname) &&
    /^\/affiliate_marketing_campaign_test_[a-z0-9_]+$/.test(url.pathname) &&
    !url.search && !url.hash, 'Expected a dedicated loopback campaign-management test database');
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
    phone: `099915000${suffix}`, name: `Campaign fixture merchant ${suffix}`, passwordHash,
    merchantProfile: { create: { shopName: `Shop ${suffix}`, shopDetails: 'Fixture details', verificationStatus } },
    wallets: { create: { role: 'merchant', availableBalanceSyp } },
  } });
  const [owner, other, pending, poor, competing, customer] = await Promise.all([
    merchant(1, 'verified', 2000000n), merchant(2, 'verified', 2000000n), merchant(3, 'pending', 500000n),
    merchant(4, 'verified', 100000n), merchant(5, 'verified', 500000n),
    db.user.create({ data: { phone: '0999150006', name: 'Fixture customer', passwordHash, isCustomer: true,
      customerProfile: { create: {} } } }),
  ]);
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  const request = (method, path, { token, input, key } = {}) => fetch(`${base}/api/v1/${path}`, {
    method, headers: {
      ...(input && { 'content-type': 'application/json' }), ...(token && { authorization: `Bearer ${token}` }),
      ...(key && { 'Idempotency-Key': key }),
    }, body: input && JSON.stringify(input), signal: AbortSignal.timeout(5000),
  });
  const login = async (user) => {
    const response = await request('POST', 'auth/login', { input: { phone: user.phone, password } });
    assert.equal(response.status, 200);
    return (await response.json()).accessToken;
  };
  const [ownerToken, otherToken, pendingToken, poorToken, competingToken, customerToken] =
    await Promise.all([owner, other, pending, poor, competing, customer].map(login));
  const path = 'merchant/campaigns';
  const pricing = { campaignType: 'product', originalPriceSyp: 100000, discountPercent: 10,
    commission: { type: 'fixed', amountSyp: 10000 }, maxItems: 30 };
  const body = { ...pricing, productName: 'Maamoul', description: 'One kilogram',
    imageUrl: 'https://demo.example.test/maamoul.jpg', joinMode: 'open', endsAt: new Date(Date.now() + 3600000).toISOString() };
  const launch = (token, input = body, key = randomUUID()) => request('POST', path, { token, input, key });
  const close = (token, id) => request('POST', `${path}/${id}/close`, { token });
  const detail = (token, id) => request('GET', `${path}/${id}`, { token });
  const wallet = (user) => db.wallet.findUniqueOrThrow({ where: { userId_role: { userId: user.id, role: 'merchant' } } });
  const movements = (campaignId, kind) => db.moneyMovement.findMany({ where: { campaignId, kind } });
  const read = async (response, status) => {
    assert.equal(response.status, status);
    return response.json();
  };
  const fail = async (response, status, code) => assert.equal((await read(response, status)).code, code);
  const launchKey = randomUUID();
  let launched;

  await t.test('launch atomically locks the preview reserve and stores one replay result', async () => {
    const preview = await read(await request('POST', `${path}/preview`, { token: ownerToken, input: pricing }), 200);
    launched = await read(await launch(ownerToken, body, launchKey), 201);
    assert.equal(launched.finalPriceSyp, preview.finalPriceSyp);
    assert.equal(launched.commissionPerItemSyp, preview.commissionPerUnitSyp);
    assert.equal(launched.usage.worstCaseReserveSyp, 435000);
    assert.equal(launched.usage.lockedBudgetSyp, preview.worstCaseReserveSyp);
    assert.equal(launched.shopName, 'Shop 1');
    assert.equal(launched.status, 'active');
    assert.equal(launched.directReferralUrl, null);
    assert.deepEqual(launched.stats, { clicks: 0, salesCount: 0, itemsSold: 0, grossCashSalesSyp: 0,
      commissionPaidSyp: 0, platformFeesPaidSyp: 0, conversionRatePercent: 0 });
    const currentWallet = await wallet(owner);
    assert.equal(currentWallet.availableBalanceSyp, 1565000n);
    const [lock] = await movements(launched.id, 'campaign_reserve_lock');
    assert.equal(lock.walletId, currentWallet.id);
    assert.equal(lock.amountSyp, 435000n);
    assert.equal(await db.idempotencyRecord.count({ where: { actorId: owner.id, requestKey: launchKey } }), 1);
    assert.deepEqual(await read(await launch(ownerToken, body, launchKey), 201), launched);
    await fail(await launch(ownerToken, { ...body, productName: 'Different product' }, launchKey), 409, 'IDEMPOTENCY_KEY_REUSED');
    assert.equal((await wallet(owner)).availableBalanceSyp, currentWallet.availableBalanceSyp);
    assert.equal((await movements(launched.id, 'campaign_reserve_lock')).length, 1);
  });

  await t.test('rejects unauthorized, unverified and unfunded launches without retaining a claim', async () => {
    const pendingKey = randomUUID();
    const poorKey = randomUUID();
    await fail(await launch(undefined), 401, 'AUTH_REQUIRED');
    await fail(await launch(customerToken), 403, 'FORBIDDEN');
    await fail(await launch(pendingToken, body, pendingKey), 403, 'MERCHANT_NOT_VERIFIED');
    await fail(await launch(poorToken, body, poorKey), 409, 'INSUFFICIENT_MERCHANT_BALANCE');
    assert.equal(await db.idempotencyRecord.count({ where: { requestKey: { in: [pendingKey, poorKey] } } }), 0);
    assert.equal((await wallet(poor)).availableBalanceSyp, 100000n);
  });

  await t.test('validates the key, ownership fields, campaign configuration and monetary boundary', async () => {
    await fail(await request('POST', path, { token: ownerToken, input: body }), 400, 'VALIDATION_ERROR');
    for (const input of [
      { ...body, merchantId: other.id }, { ...body, lockedBudgetSyp: 0 }, { ...body, joinMode: 'approval_required' },
      { ...body, imageUrl: 'ftp://demo.example.test/image' }, { ...body, endsAt: '2020-01-01T00:00:00Z' },
      { ...body, originalPriceSyp: Number.MAX_SAFE_INTEGER + 1 },
    ]) await fail(await launch(ownerToken, input), 400, 'VALIDATION_ERROR');
    await fail(await launch(ownerToken, { ...body, originalPriceSyp: Number.MAX_SAFE_INTEGER, discountPercent: 0,
      maxItems: 21, commission: { type: 'fixed', amountSyp: 0 } }), 409, 'AMOUNT_OUT_OF_RANGE');
  });

  await t.test('ledger failure rolls back wallet, campaign and idempotency claim', async () => {
    await db.$executeRaw`CREATE FUNCTION campaign_test_reject_lock() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.kind = 'campaign_reserve_lock' AND EXISTS (
          SELECT FROM campaigns WHERE id = NEW.campaign_id AND product_name = 'Reject ledger fixture'
        ) THEN RAISE EXCEPTION 'Synthetic reserve ledger failure'; END IF;
        RETURN NEW;
      END;
    $$`;
    await db.$executeRaw`CREATE TRIGGER campaign_test_reject_lock BEFORE INSERT ON money_movements
      FOR EACH ROW EXECUTE FUNCTION campaign_test_reject_lock()`;
    const key = randomUUID();
    const before = await wallet(owner);
    await fail(await launch(ownerToken, { ...body, productName: 'Reject ledger fixture' }, key), 500, 'INTERNAL_ERROR');
    assert.deepEqual(await wallet(owner), before);
    assert.equal(await db.campaign.count({ where: { merchantId: owner.id } }), 1);
    assert.equal(await db.idempotencyRecord.count({ where: { actorId: owner.id, requestKey: key } }), 0);
  });

  await t.test('concurrent distinct launches cannot overspend, and duplicate keys reserve once', async () => {
    const distinct = await Promise.all([launch(competingToken), launch(competingToken)]);
    assert.deepEqual(distinct.map(({ status }) => status).sort(), [201, 409]);
    await fail(distinct.find(({ status }) => status === 409), 409, 'INSUFFICIENT_MERCHANT_BALANCE');
    await distinct.find(({ status }) => status === 201).json();
    assert.equal(await db.campaign.count({ where: { merchantId: competing.id } }), 1);
    assert.equal((await wallet(competing)).availableBalanceSyp, 65000n);

    const key = randomUUID();
    const duplicates = await Promise.all([launch(otherToken, body, key), launch(otherToken, body, key)]);
    const [first, second] = await Promise.all(duplicates.map((response) => read(response, 201)));
    assert.deepEqual(first, second);
    assert.equal(await db.campaign.count({ where: { merchantId: other.id } }), 1);
    assert.equal((await movements(first.id, 'campaign_reserve_lock')).length, 1);
    assert.equal((await wallet(other)).availableBalanceSyp, 1565000n);
  });

  await t.test('listing and detail use ownership, status, sorting and pagination', async () => {
    const recent = await read(await launch(ownerToken, { ...body, productName: 'Second product' }), 201);
    await db.campaign.update({ where: { id: launched.id }, data: { createdAt: new Date('2026-01-01T00:00:00Z') } });
    const page = await read(await request('GET', `${path}?pageSize=1&status=active`, { token: ownerToken }), 200);
    assert.deepEqual(page, { items: [recent], page: 1, pageSize: 1, total: 2, previousPage: null, nextPage: 2 });
    const next = await read(await request('GET', `${path}?page=2&pageSize=1`, { token: ownerToken }), 200);
    assert.deepEqual(next.items, [launched]);
    assert.equal(next.previousPage, 1);
    assert.equal(next.nextPage, null);
    assert.deepEqual(await read(await detail(ownerToken, launched.id), 200), launched);
    await fail(await detail(otherToken, launched.id), 404, 'NOT_FOUND');
    await fail(await close(otherToken, launched.id), 404, 'NOT_FOUND');
    await fail(await request('GET', `${path}?pageSize=101`, { token: ownerToken }), 400, 'VALIDATION_ERROR');
  });

  await t.test('concurrent and repeated close release only the unused reserve and expire active passes', async () => {
    const [redeemed, active] = await db.$transaction(async (tx) => {
      const pass = (status) => tx.offerQrPass.create({ data: { campaignId: launched.id, customerId: customer.id,
        qrToken: randomUUID(), passCode: randomUUID(), status } });
      const redeemed = await pass('redeemed');
      const active = await pass('active');
      const sale = await tx.sale.create({ data: { offerQrPassId: redeemed.id, campaignId: launched.id, merchantId: owner.id,
        customerId: customer.id, attributionSource: 'merchant_direct', quantity: 1, originalAmountSyp: 100000n,
        customerPaidCashSyp: 90000n, marketerCommissionSyp: 0n, platformTotalFeeSyp: 4500n,
        customerCashbackSyp: 1800n, platformNetFeeSyp: 2700n, totalDeductedReserveSyp: 4500n } });
      await tx.campaign.update({ where: { id: launched.id }, data: { lockedBudgetSyp: { decrement: 4500n } } });
      await tx.moneyMovement.create({ data: { campaignId: launched.id, saleId: sale.id, kind: 'sale_reserve_debit', amountSyp: 4500n } });
      await tx.referralClick.createMany({ data: [{ campaignId: launched.id }, { campaignId: launched.id }, { campaignId: launched.id }] });
      return [redeemed, active];
    });
    const before = await wallet(owner);
    const responses = await Promise.all([close(ownerToken, launched.id), close(ownerToken, launched.id)]);
    const [first, second] = await Promise.all(responses.map((response) => read(response, 200)));
    assert.deepEqual(second, first);
    assert.equal(first.status, 'ended');
    assert.equal(first.usage.lockedBudgetSyp, 0);
    assert.equal(first.usage.itemsLeft, 29);
    assert.equal(first.usage.salesVolumeSyp, 90000);
    assert.equal(first.stats.platformFeesPaidSyp, 4500);
    assert.equal(first.stats.conversionRatePercent, 33.33);
    assert.equal((await wallet(owner)).availableBalanceSyp, before.availableBalanceSyp + 430500n);
    const unlocks = await movements(launched.id, 'campaign_reserve_unlock');
    assert.equal(unlocks.length, 1);
    assert.equal(unlocks[0].walletId, before.id);
    assert.equal(unlocks[0].amountSyp, 430500n);
    assert.equal((await db.offerQrPass.findUniqueOrThrow({ where: { id: active.id } })).status, 'expired');
    assert.equal((await db.offerQrPass.findUniqueOrThrow({ where: { id: redeemed.id } })).status, 'redeemed');
    assert.deepEqual(await read(await close(ownerToken, launched.id), 200), first);
    assert.equal((await movements(launched.id, 'campaign_reserve_unlock')).length, 1);
    assert.deepEqual(await read(await launch(ownerToken, body, launchKey), 201), launched);
  });

  await t.test('expired campaigns reconcile on reads and a close overflow rolls back', async () => {
    const expired = await read(await launch(otherToken, { ...body, productName: 'Expiring product' }), 201);
    await db.campaign.update({ where: { id: expired.id }, data: { endsAt: new Date('2020-01-01T00:00:00Z') } });
    const before = await wallet(other);
    const page = await read(await request('GET', `${path}?status=ended`, { token: otherToken }), 200);
    assert.deepEqual(page.items.map(({ id }) => id), [expired.id]);
    assert.equal((await wallet(other)).availableBalanceSyp, before.availableBalanceSyp + 435000n);
    assert.equal((await movements(expired.id, 'campaign_reserve_unlock')).length, 1);

    const overflow = await read(await launch(otherToken), 201);
    await db.wallet.update({ where: { id: before.id }, data: { availableBalanceSyp: BigInt(Number.MAX_SAFE_INTEGER) } });
    await fail(await close(otherToken, overflow.id), 409, 'AMOUNT_OUT_OF_RANGE');
    assert.equal((await detail(otherToken, overflow.id).then((response) => read(response, 200))).usage.lockedBudgetSyp, 435000);
    assert.equal((await movements(overflow.id, 'campaign_reserve_unlock')).length, 0);
  });

  await t.test('launch and preview floor fractional minor units at the same points', async () => {
    const smallPricing = { ...pricing, originalPriceSyp: 44, commission: { type: 'fixed', amountSyp: 0 }, maxItems: 2 };
    const preview = await read(await request('POST', `${path}/preview`, { token: poorToken, input: smallPricing }), 200);
    const campaign = await read(await launch(poorToken, { ...body, ...smallPricing }), 201);
    assert.equal(campaign.finalPriceSyp, 39);
    assert.equal(campaign.finalPriceSyp, preview.finalPriceSyp);
    assert.equal(campaign.usage.lockedBudgetSyp, 2);
    assert.equal(campaign.usage.lockedBudgetSyp, preview.worstCaseReserveSyp);
  });

  await t.test('Swagger publishes merchant campaign schemas and requires a UUID key only at launch', async () => {
    const doc = await read(await fetch(`${base}/api/docs-json`, { signal: AbortSignal.timeout(5000) }), 200);
    const root = doc.paths['/api/v1/merchant/campaigns'];
    const closed = doc.paths['/api/v1/merchant/campaigns/{campaignId}/close'].post;
    for (const operation of [root.get, root.post, closed, doc.paths['/api/v1/merchant/campaigns/{campaignId}'].get]) {
      assert.deepEqual(operation.security, [{ bearer: [] }]);
    }
    const key = root.post.parameters.find(({ name }) => name === 'Idempotency-Key');
    assert.equal(key.required, true);
    assert.equal(key.schema.format, 'uuid');
    assert.ok(!closed.parameters.some(({ name }) => name === 'Idempotency-Key'));
    assert.equal(root.post.requestBody.content['application/json'].schema.$ref, '#/components/schemas/LaunchCampaignDto');
    assert.equal(root.post.responses['201'].content['application/json'].schema.$ref, '#/components/schemas/MerchantCampaignDto');
    assert.equal(root.get.responses['200'].content['application/json'].schema.$ref, '#/components/schemas/MerchantCampaignPageDto');
    assert.equal(closed.responses['200'].content['application/json'].schema.$ref, '#/components/schemas/MerchantCampaignDto');
    assert.match(doc.components.schemas.CampaignUsageDto.properties.lockedBudgetSyp.description, /hundredths of one new Syrian Pound/);
  });
});
