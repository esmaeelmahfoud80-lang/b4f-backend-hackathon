const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const test = require('node:test');
const { URL } = require('node:url');
const bcrypt = require('bcrypt');
const { AbortSignal } = globalThis;

const databaseUrl = process.env.MVP_E2E_DATABASE_URL;
const reportPaths = [
  'merchant/wallet', 'merchant/wallet/transactions', 'merchant/dashboard',
  'marketer/wallet', 'marketer/wallet/by-merchant', 'marketer/wallet/transactions', 'marketer/stats',
  'customer/dashboard', 'customer/purchases',
];

test('MVP HTTP rehearsal from account registration to reserve release and final-slot settlement', {
  skip: !databaseUrl, timeout: 90000,
}, async (t) => {
  const url = new URL(databaseUrl);
  assert.ok(['postgresql:', 'postgres:'].includes(url.protocol) && url.hostname === '127.0.0.1' &&
    /^\/affiliate_marketing_e2e_test_[a-z0-9_]+$/.test(url.pathname) && !url.search && !url.hash,
  'Expected a dedicated loopback E2E database without URL options');
  process.env.DATABASE_URL = databaseUrl;
  process.env.JWT_SECRET = randomBytes(32).toString('base64url');
  process.env.WEB_BASE_URL = 'https://e2e.example.test';
  process.env.CASHBACK_MILESTONE_PURCHASES = '5';
  process.env.CASHBACK_MILESTONE_SPEND_SYP = '50000';

  const { createApp } = require('../dist/main');
  const { PrismaService } = require('../dist/prisma/prisma.service');
  const app = await createApp({ logger: false });
  t.after(() => app.close());
  const db = app.get(PrismaService).getClient();
  const [identity] = await db.$queryRaw`SELECT current_database() AS db, host(inet_server_addr()) AS host`;
  assert.deepEqual(identity, { db: url.pathname.slice(1), host: '127.0.0.1' });
  const [initial] = await db.$queryRaw`
    SELECT (SELECT count(*) FROM users) AS users, (SELECT count(*) FROM money_movements) AS ledger,
      (SELECT count(*) FROM idempotency_records) AS idempotency
  `;
  assert.deepEqual(initial, { users: 0n, ledger: 0n, idempotency: 0n }, 'Expected a fresh migrated database');
  await app.listen(0, '127.0.0.1');
  const base = `${await app.getUrl()}/api/v1`;

  function request(method, path, { token, key, body } = {}) {
    return fetch(`${base}/${path}`, { method, headers: {
      ...(token && { authorization: `Bearer ${token}` }),
      ...(key && { 'Idempotency-Key': key }),
      ...(body !== undefined && { 'content-type': 'application/json' }),
    }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  }
  async function expect(response, status, code) {
    const body = response.status === 204 ? undefined : await response.json();
    const context = `${new URL(response.url).pathname}${body?.code ? ` (${body.code})` : ''}`;
    assert.equal(response.status, status, context);
    if (code) assert.equal(body?.code, code, context);
    return body;
  }
  const get = (path, token, status = 200, code) => request('GET', path, { token }).then((res) => expect(res, status, code));
  const post = (path, options, status, code) => request('POST', path, options).then((res) => expect(res, status, code));
  const wallet = (actor, role) => db.wallet.findUniqueOrThrow({ where: { userId_role: { userId: actor.user.id, role } } });
  const campaignRow = (id) => db.campaign.findUniqueOrThrow({ where: { id } });
  const finance = () => db.$transaction([
    db.wallet.findMany({ orderBy: { id: 'asc' } }), db.customerProfile.findMany({ orderBy: { userId: 'asc' } }),
    db.campaign.findMany({ orderBy: { id: 'asc' } }), db.sale.count(), db.moneyMovement.count(), db.merchantTopup.count(),
    db.idempotencyRecord.count(),
  ]);

  // Accounts and database-backed authorization.
  const password = randomBytes(24).toString('base64url');
  const register = (suffix, roles) => post('auth/register', { body: {
    name: `E2E user ${suffix}`, phone: `099925000${suffix}`, password, roles,
    ...(roles?.includes('merchant') && { shop: { name: `E2E shop ${suffix}`, details: 'Fixture shop' } }),
  } }, roles?.length ? 201 : 400, roles?.length ? undefined : 'VALIDATION_ERROR');
  await register(8);
  await register(9, []);
  assert.equal(await db.user.count(), 0);
  const buyerSignup = await register(1, ['customer']);
  const promoter = await register(2, ['customer', 'marketer']);
  const seller = await register(3, ['merchant', 'marketer']);
  const outsider = await register(4, ['merchant', 'customer']);
  assert.deepEqual(buyerSignup.user.roles, ['customer']);
  assert.deepEqual(promoter.user.roles, ['customer', 'marketer']);
  assert.deepEqual(seller.user.roles, ['marketer', 'merchant']);
  assert.equal(seller.user.merchant.verificationStatus, 'pending');
  const buyer = await post('auth/login', { body: { phone: buyerSignup.user.phone, password } }, 200);
  assert.equal((await get('auth/me', buyer.accessToken)).id, buyer.user.id);
  await get('customer/purchases', undefined, 401, 'AUTH_REQUIRED');
  await get('merchant/wallet', buyer.accessToken, 403, 'FORBIDDEN');
  await get('admin/topups', seller.accessToken, 403, 'FORBIDDEN');
  await get(`customer/purchases?userId=${promoter.user.id}`, buyer.accessToken, 400, 'VALIDATION_ERROR');
  await db.user.update({ where: { id: promoter.user.id }, data: { isMarketer: false } });
  await get('marketer/stats', promoter.accessToken, 403, 'FORBIDDEN');
  assert.deepEqual((await get('auth/me', promoter.accessToken)).roles, ['customer']);
  await db.user.update({ where: { id: promoter.user.id }, data: { isMarketer: true } });
  assert.equal((await get('marketer/stats', promoter.accessToken)).itemsSold, 0);
  const adminRow = await db.user.create({ data: { phone: '0999250005', name: 'E2E admin',
    isAdmin: true, passwordHash: await bcrypt.hash(password, 10) } });
  const admin = await post('auth/admin/login', { body: { phone: adminRow.phone, password } }, 200);

  // Product pricing expectations independently derived from the contract's integer rules.
  const original = 100001n;
  const discount = 10n;
  const commission = 10000n;
  const maxItems = 6;
  const cash = original * (100n - discount) / 100n;
  const fee = cash * 5n / 100n;
  const cashback = cash * 2n / 100n;
  const netFee = fee - cashback;
  const debit = commission + fee;
  const reserve = debit * BigInt(maxItems);
  const topup = 200000n;
  const priceInput = { campaignType: 'product', originalPriceSyp: Number(original), discountPercent: Number(discount),
    commission: { type: 'fixed', amountSyp: Number(commission) }, maxItems };
  const campaignInput = { ...priceInput, productName: 'E2E local product', description: 'Rehearsal product',
    imageUrl: 'https://e2e.example.test/product.jpg', joinMode: 'open', endsAt: new Date(Date.now() + 3600000).toISOString() };
  const launch = (body, key, status = 201, code) =>
    post('merchant/campaigns', { token: seller.accessToken, key, body }, status, code);
  const topupPath = `admin/merchants/${seller.user.id}/topups`;
  const topupOptions = { key: randomUUID(), body: { amountSyp: Number(topup), paymentMethod: 'sham_cash', referenceNote: 'Simulated E2E payment' } };
  await launch(campaignInput, randomUUID(), 403, 'MERCHANT_NOT_VERIFIED');
  await post(topupPath, { ...topupOptions, token: admin.accessToken }, 403, 'MERCHANT_NOT_VERIFIED');
  await post(topupPath, { ...topupOptions, token: seller.accessToken }, 403, 'FORBIDDEN');
  const verify = async (actor) => expect(await request('PATCH', `admin/merchants/${actor.user.id}/verification`, {
    token: admin.accessToken, body: { status: 'verified' },
  }), 200);
  const approved = await verify(seller);
  await verify(outsider);
  assert.equal(approved.merchant.verificationStatus, 'verified');
  assert.deepEqual(approved.roles, seller.user.roles);

  // Concurrent retry, persisted top-up credit and payload conflict.
  const sendTopup = (status = 201, code, body = topupOptions.body) =>
    post(topupPath, { ...topupOptions, token: admin.accessToken, body }, status, code);
  const [credited, replayCredit] = await Promise.all([sendTopup(), sendTopup()]);
  assert.deepEqual(credited, replayCredit);
  assert.equal(credited.merchantNewAvailableBalanceSyp, Number(topup));
  const merchantWallet = await wallet(seller, 'merchant');
  assert.equal(merchantWallet.availableBalanceSyp, topup);
  const opening = await db.merchantTopup.findUniqueOrThrow({ where: { id: credited.topupId }, include: { moneyMovements: true } });
  assert.equal(opening.merchantNewAvailableBalanceSyp, topup);
  assert.equal(opening.adminId, adminRow.id);
  assert.deepEqual(opening.moneyMovements.map(({ kind, walletId, amountSyp }) => [kind, walletId, amountSyp]),
    [['merchant_topup', merchantWallet.id, topup]]);
  await sendTopup(409, 'IDEMPOTENCY_KEY_REUSED', { ...topupOptions.body, amountSyp: Number(topup + 1n) });
  assert.equal(await db.merchantTopup.count(), 1);

  // Campaign preview and launch reserves.
  const prePreview = await finance();
  const preview = await post('merchant/campaigns/preview', { token: seller.accessToken, body: priceInput }, 200);
  assert.deepEqual(preview, {
    finalPriceSyp: Number(cash), sampleSaleAmountSyp: Number(cash), commissionPerUnitSyp: Number(commission),
    platformTotalFeeSampleSyp: Number(fee), customerCashbackSampleSyp: Number(cashback), platformNetFeeSampleSyp: Number(netFee),
    merchantNetSampleSyp: Number(cash - debit), worstCaseReserveSyp: Number(reserve),
    isAffordableByMerchant: true, merchantAvailableBalanceSyp: Number(topup),
  });
  assert.deepEqual(await finance(), prePreview);
  const launchKey = randomUUID();
  const campaign = await launch(campaignInput, launchKey);
  assert.deepEqual(await launch(campaignInput, launchKey), campaign);
  await launch({ ...campaignInput, productName: 'Conflicting launch' }, launchKey, 409, 'IDEMPOTENCY_KEY_REUSED');
  assert.equal(await db.campaign.count(), 1);
  const stored = await campaignRow(campaign.id);
  assert.deepEqual([stored.merchantId, stored.status, stored.lockedBudgetSyp, stored.worstCaseReserveSyp],
    [seller.user.id, 'active', reserve, reserve]);
  assert.equal((await wallet(seller, 'merchant')).availableBalanceSyp, topup - reserve);
  await get(`merchant/campaigns/${campaign.id}`, outsider.accessToken, 404, 'NOT_FOUND');

  // Discover, join, attribute real navigation and issue a single active Offer QR.
  assert.ok((await get('campaigns', promoter.accessToken)).items.some(({ id }) => id === campaign.id));
  const join = (id, token, status = 201, code) => post(`marketer/campaigns/${id}/join`, { token }, status, code);
  await join(campaign.id, seller.accessToken, 403, 'SELF_PROMOTION_FORBIDDEN');
  const membership = await join(campaign.id, promoter.accessToken);
  assert.equal((await join(campaign.id, promoter.accessToken, 200)).id, membership.id);
  const storedMembership = await db.campaignMarketer.findUniqueOrThrow({ where: { id: membership.id } });
  const referral = new URL(membership.referralUrl);
  const code = referral.pathname.split('/').at(-1);
  assert.equal(referral.origin, 'https://e2e.example.test');
  assert.deepEqual([storedMembership.marketerId, storedMembership.campaignId, storedMembership.status, storedMembership.referralCode],
    [promoter.user.id, campaign.id, 'approved', code]);
  assert.equal(await db.campaignMarketer.count(), 1);
  const offer = await get(`public/referrals/${code}`);
  assert.equal(offer.productName, campaignInput.productName);
  assert.equal(offer.finalPriceSyp, Number(cash));
  assert.deepEqual(Object.keys(offer).sort(), ['attributionLabel', 'campaignId', 'campaignType', 'description',
    'discountPercent', 'endsAt', 'finalPriceSyp', 'imageUrl', 'originalPriceSyp', 'productName', 'shopDetails', 'shopName', 'status']);
  assert.equal(await db.referralClick.count(), 0);
  for (let i = 0; i < maxItems; i++) await post(`public/referrals/${code}/clicks`, {}, 204);
  assert.equal(await db.referralClick.count({ where: { campaignId: campaign.id, campaignMarketerId: membership.id } }), maxItems);
  assert.deepEqual(await get('marketer/stats', promoter.accessToken), { clicks: maxItems, itemsSold: 0, earnedSyp: 0, conversionRatePercent: 0 });
  const issue = (referralCode, actor, status = 201, error) =>
    post(`customer/referrals/${referralCode}/offer-qr`, { token: actor.accessToken }, status, error);
  await issue(code, promoter, 403, 'SELF_PROMOTION_FORBIDDEN');
  const pass = await issue(code, buyer);
  const existingPass = await issue(code, buyer, 200);
  assert.equal(existingPass.passId, pass.passId);
  assert.equal(existingPass.qrToken === pass.qrToken && existingPass.passCode === pass.passCode, true);
  const passRow = await db.offerQrPass.findUniqueOrThrow({ where: { id: pass.passId } });
  assert.deepEqual([passRow.customerId, passRow.campaignMarketerId, passRow.status], [buyer.user.id, membership.id, 'active']);
  assert.equal(await db.offerQrPass.count(), 1);

  // Lookup, concurrent redemption, single credit, and idempotency behavior.
  const redeemPath = 'merchant/scanner/redeem-offer';
  const redeem = (offerPass, key = randomUUID(), token = seller.accessToken, status = 201, error) =>
    post(redeemPath, { token, key, body: { code: offerPass.passCode } }, status, error);
  const beforeLookup = await finance();
  const quote = await post('merchant/scanner/lookup', { token: seller.accessToken, body: { code: pass.passCode } }, 200);
  assert.deepEqual(quote.availableQuantityOptions, [{ quantity: 1, customerPaidCashSyp: Number(cash) }]);
  await redeem(pass, randomUUID(), outsider.accessToken, 404, 'NOT_FOUND');
  await redeem(pass, randomUUID(), buyer.accessToken, 403, 'FORBIDDEN');
  assert.deepEqual(await finance(), beforeLookup);
  const keys = [randomUUID(), randomUUID()];
  const racers = await Promise.all(keys.map((key) =>
    request('POST', redeemPath, { token: seller.accessToken, key, body: { code: pass.passCode } })));
  assert.deepEqual(racers.map(({ status }) => status).sort(), [201, 409]);
  const winner = racers.findIndex(({ status }) => status === 201);
  const sale = await expect(racers[winner], 201);
  await expect(racers[1 - winner], 409, 'QR_ALREADY_REDEEMED');
  assert.deepEqual(await redeem(pass, keys[winner]), sale);
  assert.equal(await db.sale.count(), 1);
  assert.equal((await db.offerQrPass.findUniqueOrThrow({ where: { id: pass.passId } })).status, 'redeemed');
  assert.deepEqual(sale, {
    saleId: sale.saleId, campaignId: campaign.id, productName: campaignInput.productName, quantity: 1, originalAmountSyp: Number(original),
    customerPaidCashSyp: Number(cash), marketerCommissionSyp: Number(commission), platformTotalFeeSyp: Number(fee),
    customerCashbackSyp: Number(cashback), platformNetFeeSyp: Number(netFee), remainingLockedBudgetSyp: Number(reserve - debit),
    campaignStatusAfterSale: 'active', scannedAt: sale.scannedAt,
  });
  const settled = await db.sale.findUniqueOrThrow({ where: { id: sale.saleId }, include: { moneyMovements: true } });
  assert.deepEqual([settled.offerQrPassId, settled.merchantId, settled.campaignMarketerId, settled.customerId, settled.totalDeductedReserveSyp],
    [pass.passId, seller.user.id, membership.id, buyer.user.id, debit]);
  assert.deepEqual(Object.fromEntries(settled.moneyMovements.map(({ kind, amountSyp }) => [kind, amountSyp])), {
    sale_reserve_debit: debit, customer_cashback_accrual: cashback, platform_net_fee: netFee, marketer_commission_credit: commission,
  });
  assert.equal(settled.moneyMovements.length, 4);
  assert.equal((await wallet(promoter, 'marketer')).availableBalanceSyp, commission);
  const firstProfile = await db.customerProfile.findUniqueOrThrow({ where: { userId: buyer.user.id } });
  assert.deepEqual([firstProfile.lockedCashbackSyp, firstProfile.availableCashbackSyp], [cashback, 0n]);
  const nextPass = await issue(code, buyer);
  await redeem(nextPass, keys[winner], seller.accessToken, 409, 'IDEMPOTENCY_KEY_REUSED');
  await redeem(nextPass);
  const milestoneSales = 5;
  for (let i = 2; i < milestoneSales; i++) await redeem(await issue(code, buyer));
  const outstanding = await issue(code, buyer);
  const salesCount = BigInt(milestoneSales);
  const remaining = reserve - debit * salesCount;

  // All nine reports reconcile to the same settled sales, wallet and ledger values.
  const tokens = [seller, seller, seller, promoter, promoter, promoter, promoter, buyer, buyer];
  const beforeReports = await finance();
  const [sellerReport, merchantHistory, dashboard, marketerReport, merchantEarnings,
    marketerHistory, stats, customer, purchases] = await Promise.all(reportPaths.map((path, i) =>
    get(path + (path.endsWith('transactions') || path.endsWith('purchases') ? '?pageSize=2' : ''), tokens[i].accessToken)));
  assert.deepEqual(sellerReport, { availableBalanceSyp: Number(topup - reserve), totalLockedReservesSyp: Number(remaining), creditLimitSyp: 0 });
  assert.deepEqual(dashboard.wallet, sellerReport);
  assert.equal(dashboard.verificationStatus, 'verified');
  assert.equal(dashboard.activeCampaignsCount, 1);
  assert.equal(dashboard.topCampaign.campaignId, campaign.id);
  assert.equal(dashboard.stats.salesCount, milestoneSales);
  assert.equal(dashboard.stats.grossCashSalesSyp, Number(cash * salesCount));
  assert.equal(dashboard.stats.commissionPaidSyp, Number(commission * salesCount));
  assert.equal(dashboard.stats.platformFeesPaidSyp, Number(fee * salesCount));
  assert.deepEqual([merchantHistory.total, merchantHistory.items.length, merchantHistory.nextPage], [milestoneSales + 2, 2, 2]);
  assert.equal((await get('merchant/wallet/transactions?pageSize=2&page=2', seller.accessToken)).previousPage, 1);
  assert.deepEqual(marketerReport, { availableBalanceSyp: Number(commission * salesCount), pendingPayoutSyp: 0,
    totalEarnedSyp: Number(commission * salesCount), totalConfirmedPaidOutSyp: 0 });
  assert.deepEqual(merchantEarnings.items, [{ merchantId: seller.user.id, shopName: 'E2E shop 3', salesCount: milestoneSales,
    itemsSold: milestoneSales, totalEarnedSyp: Number(commission * salesCount) }]);
  assert.equal(marketerHistory.total, milestoneSales);
  assert.ok(marketerHistory.items.every(({ kind, amountSyp }) => kind === 'marketer_commission_credit' && amountSyp === Number(commission)));
  assert.deepEqual(stats, { clicks: maxItems, itemsSold: milestoneSales, earnedSyp: Number(commission * salesCount),
    conversionRatePercent: Number((salesCount * 10000n + BigInt(maxItems) / 2n) / BigInt(maxItems)) / 100 });
  assert.deepEqual(customer, { verifiedPurchaseCount: milestoneSales, milestonePurchaseCount: 0, milestonePurchasesRequired: 5,
    milestoneSpendSyp: 0, milestoneSpendRequiredSyp: 50000, lockedCashbackSyp: 0,
    availableCashbackSyp: Number(cashback * salesCount), totalCashbackUnlockedSyp: Number(cashback * salesCount) });
  assert.deepEqual([purchases.total, purchases.items.length, purchases.nextPage], [milestoneSales, 2, 2]);
  assert.ok(purchases.items.every((item) => item.customerPaidCashSyp === Number(cash) && item.cashbackEarnedSyp === Number(cashback)));
  assert.equal((await get('marketer/wallet', seller.accessToken)).availableBalanceSyp, 0);
  assert.equal((await get('customer/purchases', promoter.accessToken)).total, 0);
  assert.equal((await get('merchant/wallet', outsider.accessToken)).availableBalanceSyp, 0);
  assert.deepEqual(await finance(), beforeReports);

  // Explicit closure releases exactly the unused reserve and expires the outstanding pass.
  const closePath = `merchant/campaigns/${campaign.id}/close`;
  await post(closePath, { token: outsider.accessToken }, 404, 'NOT_FOUND');
  const closed = await post(closePath, { token: seller.accessToken }, 200);
  assert.equal(closed.status, 'ended');
  assert.equal(closed.usage.lockedBudgetSyp, 0);
  assert.deepEqual(await post(closePath, { token: seller.accessToken }, 200), closed);
  assert.equal((await wallet(seller, 'merchant')).availableBalanceSyp, topup - debit * salesCount);
  const release = await db.moneyMovement.findMany({ where: { campaignId: campaign.id, kind: 'campaign_reserve_unlock' } });
  assert.deepEqual(release.map(({ amountSyp, walletId }) => [amountSyp, walletId]), [[remaining, merchantWallet.id]]);
  await redeem(outstanding, randomUUID(), seller.accessToken, 409, 'QR_EXPIRED');
  const ledger = await db.moneyMovement.groupBy({ by: ['kind'], where: { campaignId: campaign.id }, _sum: { amountSyp: true } });
  assert.deepEqual(Object.fromEntries(ledger.map(({ kind, _sum }) => [kind, _sum.amountSyp])), {
    campaign_reserve_lock: reserve, sale_reserve_debit: debit * salesCount, campaign_reserve_unlock: remaining,
    marketer_commission_credit: commission * salesCount, customer_cashback_accrual: cashback * salesCount,
    customer_cashback_unlock: cashback * salesCount, platform_net_fee: netFee * salesCount,
  });

  await t.test('competing customers cannot exceed the final slot; winner replay stays atomic', async () => {
    const cap = await launch({ ...campaignInput, productName: 'One remaining slot', maxItems: 1 }, randomUUID());
    const capMembership = await join(cap.id, promoter.accessToken);
    const capCode = new URL(capMembership.referralUrl).pathname.split('/').at(-1);
    const contenders = await Promise.all([issue(capCode, buyer), issue(capCode, outsider)]);
    const capKeys = [randomUUID(), randomUUID()];
    const results = await Promise.all(contenders.map((item, i) =>
      request('POST', redeemPath, { token: seller.accessToken, key: capKeys[i], body: { code: item.passCode } })));
    assert.deepEqual(results.map(({ status }) => status).sort(), [201, 409]);
    const successful = results.findIndex(({ status }) => status === 201);
    const finalSale = await expect(results[successful], 201);
    await expect(results[1 - successful], 409, 'QR_EXPIRED');
    assert.equal(finalSale.campaignStatusAfterSale, 'ended');
    assert.equal(finalSale.remainingLockedBudgetSyp, 0);
    assert.deepEqual(await redeem(contenders[successful], capKeys[successful]), finalSale);
    assert.equal(await db.sale.count({ where: { campaignId: cap.id } }), 1);
    assert.equal((await campaignRow(cap.id)).lockedBudgetSyp, 0n);
    assert.equal((await wallet(seller, 'merchant')).availableBalanceSyp, topup - debit * (salesCount + 1n));
    assert.equal((await wallet(promoter, 'marketer')).availableBalanceSyp, commission * (salesCount + 1n));
  });
});
