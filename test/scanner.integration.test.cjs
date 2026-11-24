const assert = require('node:assert/strict');
const test = require('node:test');
const { randomBytes, randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { URL } = require('node:url');
const bcrypt = require('bcrypt');

const { AbortSignal } = globalThis;
const databaseUrl = process.env.SCANNER_INTEGRATION_DATABASE_URL;

test('Step 10 Offer QR scanner and settlement on isolated PostgreSQL', { skip: !databaseUrl, timeout: 45000 }, async (t) => {
  const url = new URL(databaseUrl);
  assert.ok(['postgresql:', 'postgres:'].includes(url.protocol) && ['127.0.0.1', '[::1]'].includes(url.hostname) &&
    /^\/affiliate_marketing_scanner_test_[a-z0-9_]+$/.test(url.pathname) && !url.search && !url.hash,
  'Expected a fresh loopback scanner integration database');
  process.env.DATABASE_URL = databaseUrl;
  process.env.JWT_SECRET = randomBytes(32).toString('base64url');
  process.env.CASHBACK_MILESTONE_PURCHASES = '5';
  process.env.CASHBACK_MILESTONE_SPEND_SYP = '50000';
  const { createApp } = require('../dist/main');
  const { PrismaService } = require('../dist/prisma/prisma.service');
  const { CampaignService } = require('../dist/campaign/campaign.service');
  const app = await createApp({ logger: false });
  t.after(() => app.close());
  const db = app.get(PrismaService).getClient();
  const [identity] = await db.$queryRaw`SELECT current_database() AS db, host(inet_server_addr()) AS host`;
  assert.equal(identity.db, url.pathname.slice(1));
  assert.ok(['127.0.0.1', '::1'].includes(identity.host));
  assert.equal(await db.user.count(), 0);

  const password = randomBytes(24).toString('base64url');
  const passwordHash = await bcrypt.hash(password, 10);
  const user = (suffix, roles) => db.user.create({ data: { name: `Fixture ${suffix}`, phone: `099912000${suffix}`, passwordHash, ...roles } });
  const merchantData = (verificationStatus) => ({ merchantProfile: { create: { shopName: 'Shop', shopDetails: 'Details', verificationStatus } },
    wallets: { create: { role: 'merchant', availableBalanceSyp: 100000n } } });
  const [merchant, other, pending, marketer, first, second] = await Promise.all([
    user(1, merchantData('verified')), user(2, merchantData('verified')), user(3, merchantData('pending')),
    user(4, { isMarketer: true, wallets: { create: { role: 'marketer' } } }),
    user(5, { isCustomer: true, customerProfile: { create: {} } }),
    user(6, { isCustomer: true, customerProfile: { create: { verifiedPurchaseCount: 4, milestonePurchaseCount: 4,
      milestoneSpendSyp: 160000n, lockedCashbackSyp: 3200n } } }),
  ]);
  const campaign = (overrides = {}) => db.campaign.create({ data: {
    merchantId: merchant.id, productName: 'Maamoul', description: 'Fixture', imageUrl: 'https://demo.example.test/item.jpg',
    campaignType: 'product', originalPriceSyp: 100000n, discountPercent: 10, commissionType: 'fixed', commissionValue: 10000,
    joinMode: 'open', maxItems: 30, worstCaseReserveSyp: 435000n, lockedBudgetSyp: 435000n,
    endsAt: new Date(Date.now() + 3600000), ...overrides,
  } });
  const membership = (item) => db.campaignMarketer.create({ data: { campaignId: item.id, marketerId: marketer.id, status: 'approved' } });
  const pass = (item, customer, attribution, overrides = {}) => db.offerQrPass.create({ data: {
    campaignId: item.id, customerId: customer.id, campaignMarketerId: attribution?.id,
    qrToken: randomBytes(32).toString('base64url'), passCode: `OF-${randomBytes(6).toString('hex').toUpperCase()}`, ...overrides,
  } });
  const live = await campaign();
  const attributed = await membership(live);
  const regular = await pass(live, first, attributed, { passCode: 'OF-DEMO01' });
  const milestone = await pass(live, second, attributed);

  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  const post = (path, body, token, key) => fetch(`${base}/api/v1/${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }),
      ...(key && { 'Idempotency-Key': key }) }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000),
  });
  const read = async (response, status) => { assert.equal(response.status, status); return response.json(); };
  const login = async ({ phone }) => (await read(await post('auth/login', { phone, password }), 200)).accessToken;
  const [owner, outsider, unverified, wrongRole] = await Promise.all([merchant, other, pending, marketer].map(login));
  const lookup = (code, token = owner) => post('merchant/scanner/lookup', { code }, token);
  const redeem = (code, key = randomUUID(), token = owner, extra = {}) => post('merchant/scanner/redeem-offer', { code, ...extra }, token, key);
  const fail = async (response, status, code) => {
    const body = await read(response, status);
    assert.deepEqual(Object.keys(body).sort(), ['code', 'message', 'statusCode']);
    assert.equal(body.statusCode, status);
    assert.equal(body.code, code);
  };
  const customer = (account) => db.customerProfile.findUniqueOrThrow({ where: { userId: account.id } });
  const wallet = (account, role) => db.wallet.findUniqueOrThrow({ where: { userId_role: { userId: account.id, role } } });
  const currentCampaign = (item) => db.campaign.findUniqueOrThrow({ where: { id: item.id } });
  const currentPass = (item) => db.offerQrPass.findUniqueOrThrow({ where: { id: item.id } });
  const ledger = async (saleId) => Object.fromEntries((await db.moneyMovement.findMany({ where: { saleId } })).map((row) => [row.kind, row.amountSyp]));
  const counts = () => db.$transaction([db.sale.count(), db.moneyMovement.count(), db.idempotencyRecord.count()]);

  await t.test('lookup by token or fallback returns only documented fields and preserves state', async () => {
    const before = await counts();
    const preview = await read(await lookup(regular.qrToken), 200);
    assert.deepEqual(preview, { kind: 'offer_qr', passId: regular.id, campaignId: live.id, campaignType: 'product',
      productName: live.productName, customerName: first.name, discountPercent: 10, finalPriceSyp: 90000, maxQuantity: 1,
      availableQuantityOptions: [{ quantity: 1, customerPaidCashSyp: 90000 }], status: 'active' });
    assert.deepEqual(await read(await lookup(regular.passCode), 200), preview);
    assert.deepEqual(await counts(), before);
    assert.deepEqual(await currentCampaign(live), live);
    assert.deepEqual(await currentPass(regular), regular);
    assert.equal((await wallet(marketer, 'marketer')).availableBalanceSyp, 0n);
    assert.equal((await customer(first)).lockedCashbackSyp, 0n);
  });

  await t.test('validates merchant ownership, QR availability and the one-item confirmation payload', async () => {
    await fail(await post('merchant/scanner/lookup', { code: regular.passCode }), 401, 'AUTH_REQUIRED');
    await fail(await lookup(regular.passCode, wrongRole), 403, 'FORBIDDEN');
    await fail(await lookup(regular.passCode, outsider), 404, 'NOT_FOUND');
    await fail(await redeem(regular.passCode, randomUUID(), outsider), 404, 'NOT_FOUND');
    await fail(await lookup('not-a-pass'), 404, 'NOT_FOUND');
    const pendingPass = await pass(await campaign({ merchantId: pending.id }), first);
    await fail(await redeem(pendingPass.passCode, randomUUID(), unverified), 403, 'MERCHANT_NOT_VERIFIED');
    const expiredPass = await pass(await campaign(), first, null, { status: 'expired' });
    await fail(await lookup(expiredPass.passCode), 409, 'QR_EXPIRED');
    const timedOut = await pass(await campaign({ endsAt: new Date(Date.now() - 60000) }), first);
    await fail(await redeem(timedOut.passCode), 409, 'CAMPAIGN_ENDED');
    await fail(await post('merchant/scanner/redeem-offer', { code: regular.passCode }, owner), 400, 'VALIDATION_ERROR');
    for (const extra of [{ quantity: 2 }, { quantity: null }, { originalBillSyp: 90000 }, { customerId: second.id }, { cashConfirmed: true }]) {
      await fail(await redeem(regular.passCode, randomUUID(), owner, extra), 400, 'VALIDATION_ERROR');
    }
  });

  await t.test('cash settlement persists attribution, reconciles the ledger and replays without duplication', async () => {
    const key = randomUUID();
    const saleResponse = await read(await redeem(regular.passCode, key), 201);
    assert.deepEqual(saleResponse, { saleId: saleResponse.saleId, campaignId: live.id, productName: live.productName,
      quantity: 1, originalAmountSyp: 100000, customerPaidCashSyp: 90000, marketerCommissionSyp: 10000,
      platformTotalFeeSyp: 4500, customerCashbackSyp: 1800, platformNetFeeSyp: 2700, remainingLockedBudgetSyp: 420500,
      campaignStatusAfterSale: 'active', scannedAt: saleResponse.scannedAt });
    const sale = await db.sale.findUniqueOrThrow({ where: { id: saleResponse.saleId } });
    assert.equal(sale.offerQrPassId, regular.id);
    assert.equal(sale.merchantId, merchant.id);
    assert.equal(sale.customerId, first.id);
    assert.equal(sale.campaignMarketerId, attributed.id);
    assert.equal(sale.attributionSource, 'marketer');
    assert.equal(sale.totalDeductedReserveSyp, 14500n);
    assert.equal((await currentPass(regular)).redeemedAt.toISOString(), saleResponse.scannedAt);
    assert.equal((await currentCampaign(live)).lockedBudgetSyp, 420500n);
    assert.equal((await customer(first)).lockedCashbackSyp, 1800n);
    assert.equal((await wallet(marketer, 'marketer')).availableBalanceSyp, 10000n);
    assert.equal((await wallet(merchant, 'merchant')).availableBalanceSyp, 100000n);
    assert.deepEqual(await ledger(sale.id), { sale_reserve_debit: 14500n, marketer_commission_credit: 10000n,
      customer_cashback_accrual: 1800n, platform_net_fee: 2700n });
    assert.deepEqual(await read(await redeem(regular.passCode, key, owner, { quantity: 1 }), 201), saleResponse);
    await fail(await redeem(milestone.passCode, key), 409, 'IDEMPOTENCY_KEY_REUSED');
    await fail(await redeem(regular.qrToken), 409, 'QR_ALREADY_REDEEMED');
    await fail(await lookup(regular.passCode), 409, 'QR_ALREADY_REDEEMED');
    assert.equal(await db.sale.count({ where: { offerQrPassId: regular.id } }), 1);
  });

  await t.test('the fifth qualifying sale unlocks the entire cashback cycle', async () => {
    const sold = await read(await redeem(milestone.qrToken), 201);
    assert.equal(sold.remainingLockedBudgetSyp, 406000);
    const profile = await customer(second);
    assert.equal(profile.verifiedPurchaseCount, 5);
    assert.equal(profile.milestonePurchaseCount, 0);
    assert.equal(profile.milestoneSpendSyp, 0n);
    assert.equal(profile.lockedCashbackSyp, 0n);
    assert.equal(profile.availableCashbackSyp, 5000n);
    assert.equal((await ledger(sold.saleId)).customer_cashback_unlock, 5000n);
    assert.equal(await db.sale.count({ where: { campaignId: live.id } }), 2);
  });

  await t.test('concurrent different keys on the same QR settle once', async () => {
    const item = await campaign();
    const code = await pass(item, first, await membership(item));
    const results = await Promise.all([redeem(code.passCode), redeem(code.qrToken)]);
    assert.deepEqual(results.map(({ status }) => status).sort(), [201, 409]);
    await fail(results.find(({ status }) => status === 409), 409, 'QR_ALREADY_REDEEMED');
    const saved = await read(results.find(({ status }) => status === 201), 201);
    assert.equal(await db.sale.count({ where: { campaignId: item.id } }), 1);
    assert.equal(await db.moneyMovement.count({ where: { saleId: saved.saleId } }), 4);
  });

  await t.test('competing passes cannot exceed the cap and final-sale replay preserves closure', async () => {
    const item = await campaign({ maxItems: 1, worstCaseReserveSyp: 14500n, lockedBudgetSyp: 14500n });
    const link = await membership(item);
    const [a, b] = await Promise.all([pass(item, first, link), pass(item, second, link)]);
    const keys = [randomUUID(), randomUUID()];
    const results = await Promise.all([redeem(a.passCode, keys[0]), redeem(b.passCode, keys[1])]);
    assert.deepEqual(results.map(({ status }) => status).sort(), [201, 409]);
    const winner = results.findIndex(({ status }) => status === 201);
    const saved = await read(results[winner], 201);
    await fail(results[1 - winner], 409, 'QR_EXPIRED');
    assert.equal(saved.remainingLockedBudgetSyp, 0);
    assert.equal(saved.campaignStatusAfterSale, 'ended');
    assert.equal(await db.sale.count({ where: { campaignId: item.id } }), 1);
    const winningPass = [a, b][winner];
    assert.deepEqual(await read(await redeem(winningPass.passCode, keys[winner]), 201), saved);
    await fail(await redeem(winningPass.passCode), 409, 'QR_ALREADY_REDEEMED');
  });

  await t.test('different passes share one remaining reserve and an exact volume cap closes the campaign', async () => {
    const budget = await campaign({ lockedBudgetSyp: 14500n });
    const link = await membership(budget);
    const [a, b] = await Promise.all([pass(budget, first, link), pass(budget, second, link)]);
    const competing = await Promise.all([redeem(a.passCode), redeem(b.passCode)]);
    assert.deepEqual(competing.map(({ status }) => status).sort(), [201, 409]);
    await read(competing.find(({ status }) => status === 201), 201);
    await fail(competing.find(({ status }) => status === 409), 409, 'INSUFFICIENT_LOCKED_BUDGET');
    assert.equal((await currentCampaign(budget)).lockedBudgetSyp, 0n);
    assert.equal(await db.sale.count({ where: { campaignId: budget.id } }), 1);

    const tooSmall = await campaign({ maxSalesVolumeSyp: 89999n });
    await fail(await redeem((await pass(tooSmall, first)).passCode), 409, 'CAMPAIGN_LIMIT_EXCEEDED');
    const exact = await campaign({ maxSalesVolumeSyp: 90000n });
    const code = await pass(exact, first);
    const key = randomUUID();
    const identical = await Promise.all([redeem(code.passCode, key), redeem(code.passCode, key)]);
    const [saved, replay] = await Promise.all(identical.map((response) => read(response, 201)));
    assert.deepEqual(saved, replay);
    assert.equal(saved.campaignStatusAfterSale, 'ended');
    assert.equal(await db.sale.count({ where: { campaignId: exact.id } }), 1);
  });

  await t.test('closing a final direct sale releases only the surplus and records no marketer credit', async () => {
    const item = await campaign({ maxItems: 1, worstCaseReserveSyp: 14500n, lockedBudgetSyp: 14500n });
    const code = await pass(item, first);
    const before = await wallet(merchant, 'merchant');
    const after = await read(await redeem(code.passCode), 201);
    assert.equal(after.marketerCommissionSyp, 0);
    assert.equal(after.campaignStatusAfterSale, 'ended');
    assert.equal(after.remainingLockedBudgetSyp, 0);
    assert.equal((await wallet(merchant, 'merchant')).availableBalanceSyp, before.availableBalanceSyp + 10000n);
    assert.equal((await db.sale.findUniqueOrThrow({ where: { id: after.saleId } })).attributionSource, 'merchant_direct');
    const [release] = await db.moneyMovement.findMany({ where: { campaignId: item.id, kind: 'campaign_reserve_unlock' } });
    assert.equal(release.amountSyp, 10000n);
    assert.ok(!(await ledger(after.saleId)).marketer_commission_credit);
    await read(await post(`merchant/campaigns/${item.id}/close`, {}, owner), 200);
    assert.equal(await db.moneyMovement.count({ where: { campaignId: item.id, kind: 'campaign_reserve_unlock' } }), 1);
  });

  await t.test('a redemption waiting behind explicit campaign close makes no sale', async () => {
    const item = await campaign();
    const code = await pass(item, first, await membership(item));
    let locked;
    let release;
    const ready = new Promise((resolve) => { locked = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    const closing = db.$transaction(async (tx) => {
      await app.get(CampaignService).closeInTransaction(tx, merchant.id, item.id);
      locked();
      await gate;
    }, { timeout: 8000 });
    let redemption;
    try {
      await Promise.race([ready, closing]);
      redemption = Promise.allSettled([redeem(code.passCode)]);
      const deadline = Date.now() + 2000;
      let blocked = false;
      while (!blocked && Date.now() < deadline) {
        const [activity] = await db.$queryRaw`SELECT EXISTS (SELECT 1 FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
          AND query LIKE '%SELECT id FROM campaigns WHERE id =%FOR UPDATE%') AS blocked`;
        blocked = activity.blocked;
        if (!blocked) await delay(20);
      }
      assert.ok(blocked, 'Expected scanner settlement to wait on the campaign lock');
    } finally {
      release();
      await Promise.allSettled([closing, redemption]);
    }
    await closing;
    const [result] = await redemption;
    if (result.status === 'rejected') throw result.reason;
    await fail(result.value, 409, 'QR_EXPIRED');
    assert.equal(await db.sale.count({ where: { campaignId: item.id } }), 0);
  });

  await t.test('insufficient reserve, cash rounding, and balance overflow honor monetary bounds', async () => {
    const poor = await campaign({ lockedBudgetSyp: 14499n });
    const poorPass = await pass(poor, first, await membership(poor));
    await fail(await redeem(poorPass.passCode), 409, 'INSUFFICIENT_LOCKED_BUDGET');
    assert.equal((await currentPass(poorPass)).status, 'active');
    const small = await campaign({ originalPriceSyp: 55n, commissionValue: 0, maxItems: 2, worstCaseReserveSyp: 4n, lockedBudgetSyp: 4n });
    const rounded = await read(await redeem((await pass(small, first)).passCode), 201);
    assert.equal(rounded.customerPaidCashSyp, 49);
    assert.equal(rounded.platformTotalFeeSyp, 2);
    assert.equal(rounded.customerCashbackSyp, 0);
    assert.equal(rounded.platformNetFeeSyp, 2);
    const savedWallet = await wallet(marketer, 'marketer');
    await db.wallet.update({ where: { id: savedWallet.id }, data: { availableBalanceSyp: BigInt(Number.MAX_SAFE_INTEGER) } });
    try {
      const funded = await campaign();
      const fundedPass = await pass(funded, first, await membership(funded));
      await fail(await redeem(fundedPass.passCode), 409, 'AMOUNT_OUT_OF_RANGE');
      assert.equal((await currentPass(fundedPass)).status, 'active');
      assert.equal((await currentCampaign(funded)).lockedBudgetSyp, 435000n);
    } finally {
      await db.wallet.update({ where: { id: savedWallet.id }, data: { availableBalanceSyp: savedWallet.availableBalanceSyp } });
    }
  });

  await t.test('a ledger failure rolls back QR, sale, reserve, balances and idempotency claim', async () => {
    await db.$executeRaw`CREATE FUNCTION scanner_test_reject_fee() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.kind = 'platform_net_fee' AND EXISTS (
          SELECT FROM campaigns WHERE id = NEW.campaign_id AND product_name = 'Rollback fixture'
        ) THEN RAISE EXCEPTION 'Synthetic scanner ledger failure'; END IF;
        RETURN NEW;
      END;
    $$`;
    await db.$executeRaw`CREATE TRIGGER scanner_test_reject_fee BEFORE INSERT ON money_movements
      FOR EACH ROW EXECUTE FUNCTION scanner_test_reject_fee()`;
    const item = await campaign({ productName: 'Rollback fixture' });
    const code = await pass(item, first, await membership(item));
    const key = randomUUID();
    const snapshot = [await counts(), await customer(first), await wallet(marketer, 'marketer')];
    await fail(await redeem(code.passCode, key), 500, 'INTERNAL_ERROR');
    assert.deepEqual([await counts(), await customer(first), await wallet(marketer, 'marketer')], snapshot);
    assert.deepEqual(await currentPass(code), code);
    assert.deepEqual(await currentCampaign(item), item);
  });

  await t.test('Swagger exposes the two scanner DTOs, Bearer auth and the redeem idempotency header', async () => {
    const doc = await read(await fetch(`${base}/api/docs-json`, { signal: AbortSignal.timeout(5000) }), 200);
    const peek = doc.paths['/api/v1/merchant/scanner/lookup'].post;
    const sell = doc.paths['/api/v1/merchant/scanner/redeem-offer'].post;
    for (const operation of [peek, sell]) assert.deepEqual(operation.security, [{ bearer: [] }]);
    assert.equal(peek.responses['200'].content['application/json'].schema.$ref, '#/components/schemas/ScannerOfferDto');
    assert.equal(sell.requestBody.content['application/json'].schema.$ref, '#/components/schemas/RedeemOfferDto');
    assert.equal(sell.responses['201'].content['application/json'].schema.$ref, '#/components/schemas/OfferRedeemResultDto');
    assert.ok(!peek.parameters?.some(({ name }) => name === 'Idempotency-Key'));
    assert.equal(sell.parameters.find(({ name }) => name === 'Idempotency-Key').schema.format, 'uuid');
    assert.match(doc.components.schemas.OfferRedeemResultDto.properties.platformTotalFeeSyp.description, /hundredths of one new Syrian Pound/);
    assert.ok(doc.paths['/api/v1/customer/referrals/{code}/offer-qr'].post);
  });
});
