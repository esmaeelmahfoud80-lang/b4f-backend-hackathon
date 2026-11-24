const assert = require('node:assert/strict');
const test = require('node:test');
const { randomBytes, randomUUID } = require('node:crypto');
const { URL } = require('node:url');
const { JwtService } = require('@nestjs/jwt');

const { AbortSignal } = globalThis;
const databaseUrl = process.env.MULTI_ROLE_INTEGRATION_DATABASE_URL;

test('multi-role settlement and buyer self-referral on isolated PostgreSQL', { skip: !databaseUrl, timeout: 30000 }, async (t) => {
  const url = new URL(databaseUrl);
  assert.ok(['postgresql:', 'postgres:'].includes(url.protocol) && ['127.0.0.1', '[::1]'].includes(url.hostname) &&
    /^\/affiliate_marketing_multi_role_test_[a-z0-9_]+$/.test(url.pathname) && !url.search && !url.hash,
  'Expected a dedicated loopback multi-role test database');
  const secret = randomBytes(32).toString('base64url');
  process.env.DATABASE_URL = databaseUrl;
  process.env.JWT_SECRET = secret;
  process.env.WEB_BASE_URL = 'https://demo.example.test';
  process.env.CASHBACK_MILESTONE_PURCHASES = '5';
  process.env.CASHBACK_MILESTONE_SPEND_SYP = '50000';
  const { createApp } = require('../dist/main');
  const { PrismaService } = require('../dist/prisma/prisma.service');
  const app = await createApp({ logger: false });
  t.after(() => app.close());
  const db = app.get(PrismaService).getClient();
  const [identity] = await db.$queryRaw`SELECT current_database() AS db, host(inet_server_addr()) AS host`;
  assert.equal(identity.db, url.pathname.slice(1));
  assert.ok(['127.0.0.1', '::1'].includes(identity.host));
  assert.equal(await db.user.count(), 0, 'Expected a fresh database without users');
  await app.listen(0, '127.0.0.1');
  const base = `${await app.getUrl()}/api/v1`;

  function request(method, path, { body, token, key } = {}) {
    return fetch(`${base}/${path}`, { method, headers: {
      ...(body !== undefined && { 'content-type': 'application/json' }), ...(token && { authorization: `Bearer ${token}` }),
      ...(key && { 'Idempotency-Key': key }),
    }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(8000) });
  }
  async function read(response, status) {
    assert.equal(response.status, status);
    return response.json();
  }
  async function selfReferral(response) {
    assert.deepEqual(await read(response, 403), {
      statusCode: 403, code: 'SELF_PROMOTION_FORBIDDEN', message: 'You cannot use your own marketer referral for a purchase.',
    });
  }
  const password = randomBytes(24).toString('base64url');
  const register = (suffix, roles, shop) => request('POST', 'auth/register', { body: {
    phone: `099911000${suffix}`, name: `Multi-role fixture ${suffix}`, password, roles, ...(shop && { shop }),
  } }).then((response) => read(response, 201));
  const wallet = (userId, role) => db.wallet.findUniqueOrThrow({ where: { userId_role: { userId, role } } });
  const profile = (userId) => db.customerProfile.findUniqueOrThrow({ where: { userId } });
  const join = (campaignId, token) => request('POST', `marketer/campaigns/${campaignId}/join`, { token });
  const issue = (code, token) => request('POST', `customer/referrals/${code}/offer-qr`, { token });
  const redeem = (code, token, key = randomUUID()) => request('POST', 'merchant/scanner/redeem-offer', { token, key, body: { code } });
  const codeFrom = (membership) => new URL(membership.referralUrl).pathname.split('/').at(-1);
  const finance = () => db.$transaction([
    db.offerQrPass.findMany({ orderBy: { id: 'asc' } }), db.sale.findMany({ orderBy: { id: 'asc' } }),
    db.campaign.findMany({ orderBy: { id: 'asc' } }), db.wallet.findMany({ orderBy: { id: 'asc' } }),
    db.customerProfile.findMany({ orderBy: { userId: 'asc' } }), db.moneyMovement.findMany({ orderBy: { id: 'asc' } }),
    db.idempotencyRecord.findMany({ orderBy: [{ actorId: 'asc' }, { operation: 'asc' }, { requestKey: 'asc' }] }),
    db.referralClick.count(), db.campaignMarketer.count(),
  ]);
  const makeVerifiedAndFund = (id) => db.$transaction([
    db.merchantProfile.update({ where: { userId: id }, data: { verificationStatus: 'verified' } }),
    db.wallet.update({ where: { userId_role: { userId: id, role: 'merchant' } }, data: { availableBalanceSyp: 100000n } }),
  ]);
  const launch = (token, productName) => request('POST', 'merchant/campaigns', { token, key: randomUUID(), body: {
    campaignType: 'product', productName, description: 'One box', imageUrl: 'https://demo.example.test/item.jpg',
    originalPriceSyp: 100000, discountPercent: 10, commission: { type: 'fixed', amountSyp: 10000 }, maxItems: 3,
    joinMode: 'open', endsAt: new Date(Date.now() + 3600000).toISOString(),
  } }).then((response) => read(response, 201));

  const allRoles = ['customer', 'marketer', 'merchant'];
  const account = await register(1, allRoles, { name: 'Multi-role shop', details: 'Fixture details' });
  const seller = await register(2, ['merchant', 'customer'], { name: 'Other shop', details: 'Fixture details' });
  const marketer = await register(3, ['marketer']);
  const buyer = await register(4, ['customer']);
  let actorToken;
  let campaign;
  let actorMembership;
  let otherReferral;
  let buyerPass;

  await t.test('registration provisions both role wallets and preserves all roles in login, refresh and me', async () => {
    const id = account.user.id;
    assert.deepEqual(account.user.roles, allRoles);
    assert.equal(account.user.merchant.verificationStatus, 'pending');
    assert.deepEqual(account.user.customer, { verifiedPurchaseCount: 0, availableCashbackSyp: 0, lockedCashbackSyp: 0 });
    const wallets = await db.wallet.findMany({ where: { userId: id }, orderBy: { role: 'asc' } });
    assert.deepEqual(wallets.map(({ role, availableBalanceSyp, pendingPayoutSyp }) => [role, availableBalanceSyp, pendingPayoutSyp]),
      [['merchant', 0n, 0n], ['marketer', 0n, 0n]]);
    assert.notEqual(wallets[0].id, wallets[1].id);
    assert.equal((await profile(id)).userId, id);
    const login = await read(await request('POST', 'auth/login', { body: { phone: account.user.phone, password } }), 200);
    const refreshed = await read(await request('POST', 'auth/refresh', { body: { refreshToken: login.refreshToken } }), 200);
    assert.deepEqual(login.user, account.user);
    assert.deepEqual(refreshed.user, account.user);
    for (const session of [login, refreshed]) {
      const claims = await new JwtService().verifyAsync(session.accessToken, { secret, algorithms: ['HS256'] });
      assert.equal(claims.sub, id);
      assert.deepEqual(claims.roles, allRoles);
    }
    actorToken = refreshed.accessToken;
    assert.deepEqual(await read(await request('GET', 'auth/me', { token: actorToken }), 200), account.user);
  });

  await t.test('a pending merchant can discover and join another merchant’s campaign and use customer QR issuance', async () => {
    await makeVerifiedAndFund(seller.user.id);
    campaign = await launch(seller.accessToken, 'Other shop item');
    const page = await read(await request('GET', 'campaigns', { token: actorToken }), 200);
    assert.ok(page.items.some(({ id }) => id === campaign.id));
    actorMembership = await read(await join(campaign.id, actorToken), 201);
    assert.equal(actorMembership.status, 'approved');
    assert.equal((await db.campaignMarketer.findUniqueOrThrow({ where: { id: actorMembership.id } })).marketerId, account.user.id);
    otherReferral = codeFrom(await read(await join(campaign.id, marketer.accessToken), 201));
    buyerPass = await read(await issue(otherReferral, actorToken), 201);
    assert.equal((await db.offerQrPass.findUniqueOrThrow({ where: { id: buyerPass.passId } })).customerId, account.user.id);
    assert.equal((await read(await request('GET', 'auth/me', { token: actorToken }), 200)).merchant.verificationStatus, 'pending');
  });

  await t.test('concurrent self-referral issuance creates or updates nothing', async () => {
    const before = await finance();
    const code = codeFrom(actorMembership);
    const results = await Promise.all([issue(code, actorToken), issue(code, actorToken)]);
    await Promise.all(results.map(selfReferral));
    assert.deepEqual(await finance(), before);
  });

  await t.test('a pre-existing self-referred pass remains active and all settlement state is unchanged', async () => {
    const legacy = await db.offerQrPass.create({ data: { campaignId: campaign.id, campaignMarketerId: actorMembership.id,
      customerId: account.user.id, qrToken: randomBytes(32).toString('base64url'), passCode: `OF-${randomBytes(6).toString('hex').toUpperCase()}` } });
    const before = await finance();
    // The same eligibility rule also applies when a pass already exists.
    await selfReferral(await issue(codeFrom(actorMembership), actorToken));
    const key = randomUUID();
    const results = await Promise.all([
      redeem(legacy.passCode, seller.accessToken, key), redeem(legacy.passCode, seller.accessToken, key),
      redeem(legacy.qrToken, seller.accessToken),
    ]);
    await Promise.all(results.map(selfReferral));
    assert.deepEqual(await db.offerQrPass.findUniqueOrThrow({ where: { id: legacy.id } }), legacy);
    assert.deepEqual(await finance(), before);
  });

  await t.test('a multi-role buyer credits cashback and another marketer’s commission once', async () => {
    const actorMerchant = await wallet(account.user.id, 'merchant');
    const actorMarketer = await wallet(account.user.id, 'marketer');
    const sellerWallet = await wallet(seller.user.id, 'merchant');
    const payee = await wallet(marketer.user.id, 'marketer');
    const key = randomUUID();
    const results = await Promise.all([redeem(buyerPass.passCode, seller.accessToken, key), redeem(buyerPass.passCode, seller.accessToken, key)]);
    const [sold, replay] = await Promise.all(results.map((response) => read(response, 201)));
    assert.deepEqual(replay, sold);
    assert.equal(sold.marketerCommissionSyp, 10000);
    assert.equal(sold.customerCashbackSyp, 1800);
    assert.equal((await profile(account.user.id)).lockedCashbackSyp, 1800n);
    assert.deepEqual(await wallet(account.user.id, 'merchant'), actorMerchant);
    assert.deepEqual(await wallet(account.user.id, 'marketer'), actorMarketer);
    assert.deepEqual(await wallet(seller.user.id, 'merchant'), sellerWallet);
    assert.equal((await wallet(marketer.user.id, 'marketer')).availableBalanceSyp, payee.availableBalanceSyp + 10000n);
    const sale = await db.sale.findUniqueOrThrow({ where: { id: sold.saleId }, include: { moneyMovements: true } });
    assert.equal(sale.customerId, account.user.id);
    assert.equal(sale.moneyMovements.find(({ kind }) => kind === 'marketer_commission_credit').walletId, payee.id);
    assert.equal(sale.moneyMovements.find(({ kind }) => kind === 'customer_cashback_accrual').customerId, account.user.id);
    assert.equal(await db.sale.count({ where: { offerQrPassId: buyerPass.passId } }), 1);
    assert.equal((await read(await redeem(buyerPass.passCode, seller.accessToken), 409)).code, 'QR_ALREADY_REDEEMED');
  });

  await t.test('the same account can earn commission elsewhere, launch its own campaign and honor direct offers', async () => {
    await makeVerifiedAndFund(account.user.id);
    const actorMerchant = await wallet(account.user.id, 'merchant');
    const actorMarketer = await wallet(account.user.id, 'marketer');
    const actorCashback = await profile(account.user.id);
    const referred = await read(await issue(codeFrom(actorMembership), buyer.accessToken), 201);
    const attributedSale = await read(await redeem(referred.passCode, seller.accessToken), 201);
    assert.equal(attributedSale.marketerCommissionSyp, 10000);
    assert.equal((await wallet(account.user.id, 'marketer')).availableBalanceSyp, actorMarketer.availableBalanceSyp + 10000n);
    assert.deepEqual(await wallet(account.user.id, 'merchant'), actorMerchant);
    assert.deepEqual(await profile(account.user.id), actorCashback);

    const owned = await launch(actorToken, 'Multi-role shop item');
    const ownJoins = await Promise.all([join(owned.id, actorToken), join(owned.id, actorToken)]);
    for (const response of ownJoins) assert.equal((await read(response, 403)).code, 'SELF_PROMOTION_FORBIDDEN');
    assert.equal(await db.campaignMarketer.count({ where: { campaignId: owned.id } }), 0);
    const directCode = `md-${randomBytes(8).toString('hex')}`;
    await db.campaign.update({ where: { id: owned.id }, data: { directReferralCode: directCode } });
    const direct = await read(await issue(directCode, seller.accessToken), 201);
    const directSale = await read(await redeem(direct.passCode, actorToken), 201);
    const persisted = await db.sale.findUniqueOrThrow({ where: { id: directSale.saleId } });
    assert.equal(persisted.customerId, seller.user.id);
    assert.equal(persisted.attributionSource, 'merchant_direct');
    assert.equal(persisted.campaignMarketerId, null);
    assert.equal(directSale.marketerCommissionSyp, 0);
    assert.equal((await profile(seller.user.id)).lockedCashbackSyp, 1800n);
    assert.equal((await wallet(account.user.id, 'merchant')).availableBalanceSyp, actorMerchant.availableBalanceSyp - 43500n);
    assert.equal((await wallet(account.user.id, 'marketer')).availableBalanceSyp, actorMarketer.availableBalanceSyp + 10000n);
  });
});
