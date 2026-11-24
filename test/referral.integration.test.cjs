const assert = require('node:assert/strict');
const test = require('node:test');
const { randomBytes, randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { URL } = require('node:url');
const bcrypt = require('bcrypt');

const { AbortSignal } = globalThis;
const databaseUrl = process.env.REFERRAL_INTEGRATION_DATABASE_URL;

test('Step 09 referrals and Offer QR on isolated PostgreSQL', { skip: !databaseUrl, timeout: 30000 }, async (t) => {
  const url = new URL(databaseUrl);
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol) && ['127.0.0.1', '[::1]'].includes(url.hostname) &&
    /^\/affiliate_marketing_referral_test_[a-z0-9_]+$/.test(url.pathname) && !url.search && !url.hash,
  'Expected a dedicated loopback referral test database');
  process.env.JWT_SECRET = randomBytes(32).toString('base64url');
  process.env.DATABASE_URL = databaseUrl;
  const { createApp } = require('../dist/main');
  const { PrismaService } = require('../dist/prisma/prisma.service');
  const { CampaignService } = require('../dist/campaign/campaign.service');
  const app = await createApp({ logger: false });
  t.after(() => app.close());
  const db = app.get(PrismaService).getClient();
  const [identity] = await db.$queryRaw`SELECT current_database() AS db, host(inet_server_addr()) AS host`;
  assert.equal(identity.db, url.pathname.slice(1));
  assert.ok(['127.0.0.1', '::1'].includes(identity.host));
  assert.equal(await db.user.count(), 0, 'Expected a fresh database without users');

  const password = randomBytes(24).toString('base64url');
  const passwordHash = await bcrypt.hash(password, 10);
  const user = (suffix, roles) => db.user.create({ data: { phone: `099913000${suffix}`, name: `Fixture ${suffix}`, passwordHash, ...roles } });
  const shop = (verificationStatus) => ({ merchantProfile: { create: { shopName: 'Bakery', shopDetails: 'Open until 18:00', verificationStatus } },
    wallets: { create: { role: 'merchant', availableBalanceSyp: 100000n } } });
  const customer = { isCustomer: true, customerProfile: { create: {} } };
  const [merchant, pendingMerchant, marketer, otherMarketer, first, second] = await Promise.all([
    user(1, shop('verified')), user(2, shop('pending')), user(3, { isMarketer: true }),
    user(4, { isMarketer: true }), user(5, customer), user(6, customer),
  ]);
  const future = new Date(Date.now() + 3600000);
  const yesterday = new Date(Date.now() - 86400000);
  const campaign = (overrides = {}) => db.campaign.create({ data: {
    merchantId: merchant.id, productName: 'Maamoul', description: 'One kilogram', imageUrl: 'https://demo.example.test/item.jpg',
    campaignType: 'product', originalPriceSyp: 100000n, discountPercent: 10, commissionType: 'fixed', commissionValue: 10000,
    joinMode: 'open', maxItems: 30, worstCaseReserveSyp: 435000n, lockedBudgetSyp: 435000n, endsAt: future, ...overrides,
  } });
  const [active, different, ended, expired, hidden, race] = await Promise.all([
    campaign({ directReferralCode: 'md-direct' }), campaign(), campaign({ status: 'ended', closedAt: yesterday, lockedBudgetSyp: 0n }),
    campaign({ endsAt: yesterday }), campaign({ merchantId: pendingMerchant.id }), campaign(),
  ]);
  const membership = (record, marketerId, referralCode, status = 'approved') => db.campaignMarketer.create({
    data: { campaignId: record.id, marketerId, referralCode, status },
  });
  const [attributed, alternate, crossCampaign] = await Promise.all([
    membership(active, marketer.id, 'mk-first'), membership(active, otherMarketer.id, 'mk-alternate'),
    membership(different, marketer.id, 'mk-different'), membership(ended, marketer.id, 'mk-ended'),
    membership(expired, marketer.id, 'mk-expired'), membership(hidden, marketer.id, 'mk-hidden'),
    membership(race, marketer.id, 'mk-race'), membership(different, otherMarketer.id, null, 'pending'),
  ]);
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  const request = (method, path, token, body) => fetch(`${base}/api/v1/${path}`, {
    method, headers: { ...(token && { authorization: `Bearer ${token}` }), ...(body !== undefined && { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(8000),
  });
  const read = async (response, status) => { assert.equal(response.status, status); return response.json(); };
  const login = async ({ phone }) => (await read(await request('POST', 'auth/login', undefined, { phone, password }), 200)).accessToken;
  const [customerToken, otherCustomerToken, marketerToken] = await Promise.all([first, second, marketer].map(login));
  const offer = (code) => request('GET', `public/referrals/${code}`);
  const click = (code, body) => request('POST', `public/referrals/${code}/clicks`, undefined, body);
  const issue = (code, token, body) => request('POST', `customer/referrals/${code}/offer-qr`, token, body);
  const fail = async (response, status, code) => {
    const error = await read(response, status);
    assert.deepEqual(Object.keys(error).sort(), ['code', 'message', 'statusCode']);
    assert.equal(error.statusCode, status);
    assert.equal(error.code, code);
    assert.equal(typeof error.message, 'string');
  };
  const pass = (id) => db.offerQrPass.findUniqueOrThrow({ where: { id } });
  const financialSnapshot = () => db.$transaction([
    db.wallet.findMany({ orderBy: { id: 'asc' } }), db.campaign.findMany({ orderBy: { id: 'asc' } }),
    db.customerProfile.findMany({ orderBy: { userId: 'asc' } }), db.moneyMovement.count(), db.sale.count(), db.idempotencyRecord.count(),
  ]);
  const before = await financialSnapshot();
  let original;

  await t.test('public offers expose exactly the safe contract data and never record a click on GET', async () => {
    assert.deepEqual(await read(await offer('mk-first'), 200), {
      campaignId: active.id, campaignType: 'product', shopName: 'Bakery', shopDetails: 'Open until 18:00', productName: 'Maamoul',
      description: 'One kilogram', imageUrl: 'https://demo.example.test/item.jpg', originalPriceSyp: 100000, discountPercent: 10,
      finalPriceSyp: 90000, endsAt: future.toISOString(), status: 'active', attributionLabel: 'Marketer referral',
    });
    assert.equal((await read(await offer('md-direct'), 200)).attributionLabel, 'Merchant direct');
    for (const code of ['missing', 'mk-expired', 'mk-ended', 'mk-hidden', 'mk-FIRST', '%3F']) await fail(await offer(code), 404, 'NOT_FOUND');
    assert.equal(await db.referralClick.count(), 0);
  });

  await t.test('click POST tracks only the resolved campaign and attribution', async () => {
    for (const code of ['mk-first', 'mk-first', 'mk-different', 'md-direct']) {
      const response = await click(code);
      assert.equal(response.status, 204);
      assert.equal(await response.text(), '');
    }
    await fail(await click('mk-expired'), 409, 'CAMPAIGN_ENDED');
    await fail(await click('missing'), 404, 'NOT_FOUND');
    await fail(await click('mk-first', { campaignId: different.id }), 400, 'VALIDATION_ERROR');
    const rows = await db.referralClick.findMany({ orderBy: { id: 'asc' }, select: { campaignId: true, campaignMarketerId: true } });
    assert.deepEqual(rows, [
      { campaignId: active.id, campaignMarketerId: attributed.id }, { campaignId: active.id, campaignMarketerId: attributed.id },
      { campaignId: different.id, campaignMarketerId: crossCampaign.id }, { campaignId: active.id, campaignMarketerId: null },
    ]);
  });

  await t.test('issuance requires a customer and permits only server-derived attribution', async () => {
    await fail(await issue('mk-first'), 401, 'AUTH_REQUIRED');
    await fail(await issue('mk-first', marketerToken), 403, 'FORBIDDEN');
    await fail(await issue('mk-first', customerToken, { customerId: second.id, campaignMarketerId: crossCampaign.id }), 400, 'VALIDATION_ERROR');
    const response = await issue('mk-first', customerToken);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    original = await read(response, 201);
    assert.deepEqual(Object.keys(original).sort(), ['campaignId', 'campaignType', 'createdAt', 'discountPercent',
      'finalPriceSyp', 'passCode', 'passId', 'productName', 'qrToken', 'shopName', 'status']);
    assert.equal(original.finalPriceSyp, 90000);
    assert.equal(original.status, 'active');
    assert.match(original.qrToken, /^[A-Za-z0-9_-]{43}$/);
    assert.match(original.passCode, /^OF-[A-F0-9]{12}$/);
    assert.equal((await pass(original.passId)).customerId, first.id);
    assert.equal((await pass(original.passId)).campaignMarketerId, attributed.id);
    assert.deepEqual(await read(await issue('mk-first', customerToken), 200), original);
  });

  await t.test('another customer, campaign or attribution cannot receive the first customer’s pass', async () => {
    const [customerPass, alternatePass, crossPass, directPass] = await Promise.all([
      issue('mk-first', otherCustomerToken), issue('mk-alternate', customerToken),
      issue('mk-different', customerToken), issue('md-direct', customerToken),
    ].map(async (response) => read(await response, 201)));
    assert.equal(new Set([original, customerPass, alternatePass, crossPass, directPass].map(({ qrToken }) => qrToken)).size, 5);
    assert.equal((await pass(customerPass.passId)).customerId, second.id);
    assert.equal((await pass(alternatePass.passId)).campaignMarketerId, alternate.id);
    assert.equal((await pass(crossPass.passId)).campaignId, different.id);
    assert.equal((await pass(crossPass.passId)).campaignMarketerId, crossCampaign.id);
    assert.equal((await pass(directPass.passId)).campaignMarketerId, null);
    await assert.rejects(db.offerQrPass.create({ data: { campaignId: active.id, campaignMarketerId: crossCampaign.id,
      customerId: first.id, qrToken: randomUUID(), passCode: randomUUID() } }), { code: 'P2003' });
  });

  await t.test('redeemed and expired passes are replaced, while concurrent issuance reuses one active pass', async () => {
    await db.offerQrPass.update({ where: { id: original.passId }, data: { status: 'redeemed', redeemedAt: new Date() } });
    const replacement = await read(await issue('mk-first', customerToken), 201);
    assert.notEqual(replacement.passId, original.passId);
    await db.offerQrPass.update({ where: { id: replacement.passId }, data: { status: 'expired' } });
    const responses = await Promise.all([issue('mk-first', customerToken), issue('mk-first', customerToken)]);
    assert.deepEqual(responses.map(({ status }) => status).sort(), [200, 201]);
    const [one, two] = await Promise.all(responses.map((response) => response.json()));
    assert.deepEqual(one, two);
    assert.notEqual(one.passId, replacement.passId);
    assert.equal(await db.offerQrPass.count({ where: { customerId: first.id, campaignId: active.id, campaignMarketerId: attributed.id, status: 'active' } }), 1);
    for (const code of ['mk-ended', 'mk-expired']) await fail(await issue(code, customerToken), 409, 'CAMPAIGN_ENDED');
    assert.deepEqual(await financialSnapshot(), before);
  });

  await t.test('a request blocked behind the actual close transaction cannot issue a pass', async () => {
    const earlier = await read(await issue('mk-race', otherCustomerToken), 201);
    const service = app.get(CampaignService);
    let locked;
    let release;
    const ready = new Promise((resolve) => { locked = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    const closing = db.$transaction(async (tx) => {
      await service.closeInTransaction(tx, merchant.id, race.id);
      locked();
      await gate;
    }, { timeout: 8000 });
    let issuing;
    try {
      await Promise.race([ready, closing]);
      issuing = Promise.allSettled([issue('mk-race', customerToken)]);
      const deadline = Date.now() + 2000;
      let blocked = false;
      while (!blocked && Date.now() < deadline) {
        const [activity] = await db.$queryRaw`SELECT EXISTS (SELECT 1 FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
          AND query LIKE '%SELECT id FROM campaigns WHERE id =%FOR UPDATE%') AS blocked`;
        blocked = activity.blocked;
        if (!blocked) await delay(20);
      }
      assert.ok(blocked, 'Expected issuance to wait on the campaign lock');
    } finally {
      release();
      // Drain both operations without replacing any failure from the lock check.
      await Promise.allSettled([closing, issuing]);
    }
    await closing;
    const [result] = await issuing;
    if (result.status === 'rejected') throw result.reason;
    await fail(result.value, 409, 'CAMPAIGN_ENDED');
    assert.equal((await pass(earlier.passId)).status, 'expired');
    assert.equal(await db.offerQrPass.count({ where: { campaignId: race.id, customerId: first.id } }), 0);
    await fail(await offer('mk-race'), 404, 'NOT_FOUND');
  });

  await t.test('Swagger distinguishes public routes, protected issuance, status codes and expiry semantics', async () => {
    const doc = await read(await fetch(`${base}/api/docs-json`, { signal: AbortSignal.timeout(5000) }), 200);
    const get = doc.paths['/api/v1/public/referrals/{code}'].get;
    const post = doc.paths['/api/v1/public/referrals/{code}/clicks'].post;
    const issue = doc.paths['/api/v1/customer/referrals/{code}/offer-qr'].post;
    assert.equal(get.security, undefined);
    assert.equal(post.security, undefined);
    assert.ok(post.responses['204']);
    assert.deepEqual(issue.security, [{ bearer: [] }]);
    assert.equal(issue.requestBody, undefined);
    assert.equal(get.responses['200'].content['application/json'].schema.$ref, '#/components/schemas/PublicOfferDto');
    for (const status of ['200', '201']) {
      assert.equal(issue.responses[status].content['application/json'].schema.$ref, '#/components/schemas/OfferQrPassDto');
    }
    assert.match(issue.responses['409'].description, /CAMPAIGN_ENDED/);
    const props = doc.components.schemas.OfferQrPassDto.properties;
    assert.match(props.finalPriceSyp.description, /hundredths of one new Syrian Pound/);
    assert.match(props.status.description, /no independent TTL/);
    assert.ok(doc.paths['/api/v1/marketer/campaigns/{campaignId}/join'].post);
  });
});
