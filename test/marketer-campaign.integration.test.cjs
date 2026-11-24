const assert = require('node:assert/strict');
const test = require('node:test');
const { randomBytes, randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { URL } = require('node:url');
const bcrypt = require('bcrypt');

const { AbortSignal } = globalThis;
const databaseUrl = process.env.MARKETER_CAMPAIGN_INTEGRATION_DATABASE_URL;

test('Step 08 marketer campaign discovery and joining on isolated PostgreSQL', { skip: !databaseUrl, timeout: 30000 }, async (t) => {
  const url = new URL(databaseUrl);
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol) && ['127.0.0.1', '[::1]'].includes(url.hostname) &&
    /^\/affiliate_marketing_marketer_test_[a-z0-9_]+$/.test(url.pathname) && !url.search && !url.hash,
  'Expected a dedicated loopback marketer campaign test database');
  process.env.JWT_SECRET = randomBytes(32).toString('base64url');
  process.env.DATABASE_URL = databaseUrl;
  process.env.WEB_BASE_URL = 'https://demo.example.test';
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
  const fixture = (suffix, roles) => db.user.create({ data: {
    phone: `099914000${suffix}`, name: `Marketer fixture ${suffix}`, passwordHash, ...roles,
  } });
  const merchantFixture = (verificationStatus, shopName) => ({
    merchantProfile: { create: { shopName, shopDetails: 'Private fixture details', verificationStatus } },
    wallets: { create: { role: 'merchant', availableBalanceSyp: 100000n } },
  });
  const [verified, unverified, marketer, other] = await Promise.all([
    fixture(1, { isMarketer: true, ...merchantFixture('verified', 'Bakery') }),
    fixture(2, merchantFixture('pending', 'Pending shop')),
    fixture(3, { isMarketer: true }), fixture(4, { isMarketer: true }),
  ]);
  const future = new Date(Date.now() + 3600000);
  const yesterday = new Date(Date.now() - 86400000);
  const sameCreationTime = new Date(Date.now() - 60000);
  const campaign = (productName, overrides = {}) => db.campaign.create({ data: {
    merchantId: verified.id, productName, description: 'One kilogram', imageUrl: 'https://demo.example.test/item.jpg',
    campaignType: 'product', originalPriceSyp: 100000n, discountPercent: 10, commissionType: 'fixed', commissionValue: 10000,
    joinMode: 'open', maxItems: 30, worstCaseReserveSyp: 435000n, lockedBudgetSyp: 435000n, endsAt: future,
    ...overrides,
  } });
  const [shared, tied, ended, expired, hidden, approval, race] = await Promise.all([
    campaign('Maamoul', { createdAt: sameCreationTime }), campaign('Bread', { createdAt: sameCreationTime }),
    campaign('Ended', { status: 'ended', closedAt: yesterday, lockedBudgetSyp: 0n }),
    campaign('Expired', { endsAt: yesterday }), campaign('Hidden', { merchantId: unverified.id }),
    campaign('Approval only', { joinMode: 'approval_required' }), campaign('Close race', { createdAt: yesterday }),
  ]);
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  const request = (method, path, token, body) => fetch(`${base}/api/v1/${path}`, {
    method, headers: { ...(token && { authorization: `Bearer ${token}` }), ...(body !== undefined && { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(8000),
  });
  async function read(response, status) {
    assert.equal(response.status, status);
    return response.json();
  }
  const login = async (user) => (await read(await request('POST', 'auth/login', undefined, { phone: user.phone, password }), 200)).accessToken;
  const [ownerToken, wrongRoleToken, marketerToken, otherToken] = await Promise.all([verified, unverified, marketer, other].map(login));
  const get = (path, token = marketerToken) => request('GET', path, token);
  const join = (campaignId, token, body) => request('POST', `marketer/campaigns/${campaignId}/join`, token, body);
  const fail = async (response, status, code) => {
    const error = await read(response, status);
    assert.deepEqual(Object.keys(error).sort(), ['code', 'message', 'statusCode']);
    assert.equal(error.code, code);
    assert.equal(error.statusCode, status);
    assert.equal(typeof error.message, 'string');
  };
  const snapshot = () => db.$transaction([
    db.wallet.findMany({ orderBy: { id: 'asc' } }), db.campaign.findMany({ orderBy: { id: 'asc' } }),
    db.moneyMovement.count(), db.sale.count(), db.offerQrPass.count(), db.referralClick.count(), db.idempotencyRecord.count(),
  ]);
  const initial = await snapshot();
  let membership;

  await t.test('discovery filters visibility, supports search and pagination, and orders timestamp ties by ID', async () => {
    const ids = [shared.id, tied.id].sort().reverse();
    const first = await read(await get('campaigns?joinMode=open&campaignType=product&pageSize=1&q=bAkErY'), 200);
    assert.deepEqual({ ...first, items: first.items.map(({ id }) => id) },
      { items: [ids[0]], page: 1, pageSize: 1, total: 3, previousPage: null, nextPage: 2 });
    const second = await read(await get('campaigns?page=2&pageSize=1'), 200);
    assert.equal(second.items[0].id, ids[1]);
    const all = await read(await get('campaigns'), 200);
    assert.deepEqual(all.items.map(({ id }) => id), [...ids, race.id]);
    assert.equal((await read(await get('campaigns?joinMode=approval_required'), 200)).total, 0);
    assert.equal((await read(await get('campaigns?campaignType=store_discount'), 200)).total, 0);
    assert.equal((await read(await get('campaigns?q=%25'), 200)).total, 0);
    assert.equal((await read(await get('campaigns?q=maamoul'), 200)).items[0].id, shared.id);
    await fail(await get('campaigns?pageSize=101'), 400, 'VALIDATION_ERROR');
  });

  await t.test('details return only the contract Campaign DTO and hide unavailable campaigns', async () => {
    assert.deepEqual(await read(await get(`campaigns/${shared.id}`), 200), {
      id: shared.id, campaignType: 'product', shopName: 'Bakery', productName: 'Maamoul', description: 'One kilogram',
      imageUrl: 'https://demo.example.test/item.jpg', originalPriceSyp: 100000, discountPercent: 10, finalPriceSyp: 90000,
      commission: { type: 'fixed', amountSyp: 10000 }, commissionPerItemSyp: 10000, joinMode: 'open', status: 'active',
      endsAt: future.toISOString(),
    });
    for (const id of [ended.id, expired.id, hidden.id, approval.id, randomUUID()]) {
      await fail(await get(`campaigns/${id}`), 404, 'NOT_FOUND');
    }
    await fail(await request('GET', 'campaigns'), 401, 'AUTH_REQUIRED');
    await fail(await get(`campaigns/${shared.id}`, wrongRoleToken), 403, 'FORBIDDEN');
  });

  await t.test('open join creates one approved membership and reuses the referral URL on retries', async () => {
    assert.deepEqual(await read(await get(`marketer/campaigns/${shared.id}/membership`), 200), { membership: null });
    membership = await read(await join(shared.id, marketerToken), 201);
    assert.deepEqual(Object.keys(membership).sort(), ['campaign', 'id', 'referralUrl', 'requestedAt', 'stats', 'status']);
    assert.equal(membership.campaign.id, shared.id);
    assert.equal(membership.status, 'approved');
    assert.deepEqual(membership.stats, { clicks: 0, itemsSold: 0, earnedSyp: 0, conversionRatePercent: 0 });
    assert.match(membership.referralUrl, /^https:\/\/demo\.example\.test\/r\/mk-[a-f0-9]{32}$/);
    const record = await db.campaignMarketer.findUniqueOrThrow({ where: { id: membership.id } });
    assert.equal(record.marketerId, marketer.id);
    assert.equal(record.requestedAt.toISOString(), membership.requestedAt);
    assert.ok(membership.referralUrl.endsWith(record.referralCode));
    assert.deepEqual(await read(await join(shared.id, marketerToken), 200), membership);
    assert.deepEqual(await read(await get(`marketer/campaigns/${shared.id}/membership`), 200), { membership });
    assert.deepEqual(await read(await get(`marketer/campaigns/${shared.id}/membership`, otherToken), 200), { membership: null });
    assert.deepEqual((await read(await get('marketer/memberships?pageSize=1&status=approved'), 200)).items, [membership]);
    assert.equal((await read(await get('marketer/memberships?status=rejected'), 200)).total, 0);
  });

  await t.test('concurrent duplicates share one membership and referral code', async () => {
    const responses = await Promise.all([join(tied.id, marketerToken), join(tied.id, marketerToken)]);
    assert.deepEqual(responses.map(({ status }) => status).sort(), [200, 201]);
    const [first, second] = await Promise.all(responses.map((response) => response.json()));
    assert.deepEqual(first, second);
    assert.notEqual(first.referralUrl, membership.referralUrl);
    assert.equal(await db.campaignMarketer.count({ where: { campaignId: tied.id, marketerId: marketer.id } }), 1);
  });

  await t.test('rejected memberships can resubmit in open campaigns and pending requests remain pending', async () => {
    const rejected = await db.campaignMarketer.create({ data: { campaignId: shared.id, marketerId: other.id, status: 'rejected' } });
    const pending = await db.campaignMarketer.create({ data: { campaignId: tied.id, marketerId: other.id, status: 'pending' } });
    const resubmitted = await read(await join(shared.id, otherToken), 200);
    assert.equal(resubmitted.id, rejected.id);
    assert.equal(resubmitted.status, 'approved');
    assert.ok(resubmitted.referralUrl);
    await fail(await join(tied.id, otherToken), 409, 'JOIN_REQUEST_PENDING');
    assert.equal((await db.campaignMarketer.findUniqueOrThrow({ where: { id: pending.id } })).status, 'pending');
  });

  await t.test('failed joins preserve eligibility and leave financial and referral-tracking state unchanged', async () => {
    await fail(await join(shared.id), 401, 'AUTH_REQUIRED');
    await fail(await join(shared.id, wrongRoleToken), 403, 'FORBIDDEN');
    await fail(await join(shared.id, ownerToken), 403, 'SELF_PROMOTION_FORBIDDEN');
    await fail(await join(shared.id, otherToken, { marketerId: marketer.id }), 400, 'VALIDATION_ERROR');
    for (const id of [expired.id, ended.id]) await fail(await join(id, marketerToken), 409, 'CAMPAIGN_ENDED');
    for (const id of [hidden.id, approval.id, randomUUID()]) await fail(await join(id, marketerToken), 404, 'NOT_FOUND');
    assert.deepEqual(await snapshot(), initial);
  });

  await t.test('a join waiting behind the real close transaction creates no membership', async () => {
    const service = app.get(CampaignService);
    let closed;
    const closeReached = new Promise((resolve) => { closed = resolve; });
    let release;
    const releaseClose = new Promise((resolve) => { release = resolve; });
    const closing = db.$transaction(async (tx) => {
      await service.closeInTransaction(tx, verified.id, race.id);
      closed();
      await releaseClose;
    }, { timeout: 8000 });
    let joining;
    try {
      await Promise.race([closeReached, closing]);
      joining = Promise.allSettled([join(race.id, marketerToken)]);
      const deadline = Date.now() + 2000;
      let blocked = false;
      while (!blocked && Date.now() < deadline) {
        const [activity] = await db.$queryRaw`SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'
          AND query LIKE '%SELECT id FROM campaigns WHERE id =%FOR UPDATE%'
        ) AS blocked`;
        blocked = activity.blocked;
        if (!blocked) await delay(20);
      }
      assert.ok(blocked, 'Expected the join connection to wait on the campaign row');
    } finally {
      release();
      // Drain both operations without replacing any failure from the lock check.
      await Promise.allSettled([closing, joining]);
    }
    await closing;
    const [result] = await joining;
    if (result.status === 'rejected') throw result.reason;
    await fail(result.value, 409, 'CAMPAIGN_ENDED');
    assert.equal(await db.campaignMarketer.count({ where: { campaignId: race.id } }), 0);
    assert.equal(await db.moneyMovement.count({ where: { campaignId: race.id, kind: 'campaign_reserve_unlock' } }), 1);
    assert.equal((await db.campaign.findUniqueOrThrow({ where: { id: race.id } })).status, 'ended');
  });

  await t.test('Swagger describes discovery filters, join statuses, authorization and money units', async () => {
    const doc = await read(await fetch(`${base}/api/docs-json`, { signal: AbortSignal.timeout(5000) }), 200);
    const discover = doc.paths['/api/v1/campaigns'].get;
    const details = doc.paths['/api/v1/campaigns/{campaignId}'].get;
    const joins = doc.paths['/api/v1/marketer/campaigns/{campaignId}/join'].post;
    const lookup = doc.paths['/api/v1/marketer/campaigns/{campaignId}/membership'].get;
    const memberships = doc.paths['/api/v1/marketer/memberships'].get;
    for (const operation of [discover, details, joins, lookup, memberships]) assert.deepEqual(operation.security, [{ bearer: [] }]);
    assert.deepEqual(discover.parameters.map(({ name }) => name).sort(), ['campaignType', 'joinMode', 'page', 'pageSize', 'q']);
    assert.equal(joins.requestBody, undefined);
    assert.equal(details.responses['200'].content['application/json'].schema.$ref, '#/components/schemas/CampaignDto');
    for (const status of ['200', '201']) {
      assert.equal(joins.responses[status].content['application/json'].schema.$ref, '#/components/schemas/MarketerMembershipDto');
    }
    assert.match(joins.responses['409'].description, /CAMPAIGN_ENDED/);
    assert.match(doc.components.schemas.CampaignDto.properties.finalPriceSyp.description, /hundredths of one new Syrian Pound/);
    assert.ok(doc.paths['/api/v1/merchant/campaigns'].post);
  });
});
