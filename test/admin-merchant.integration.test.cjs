const assert = require('node:assert/strict');
const test = require('node:test');
const { randomBytes, randomUUID } = require('node:crypto');
const { URL } = require('node:url');
const bcrypt = require('bcrypt');

const { AbortSignal } = globalThis;
const databaseUrl = process.env.ADMIN_MERCHANT_INTEGRATION_DATABASE_URL;

test('Step 11A admin merchant verification on isolated PostgreSQL', { skip: !databaseUrl, timeout: 30000 }, async (t) => {
  const url = new URL(databaseUrl);
  assert.ok(['postgresql:', 'postgres:'].includes(url.protocol) && ['127.0.0.1', '[::1]'].includes(url.hostname) &&
    /^\/affiliate_marketing_admin_merchant_test_[a-z0-9_]+$/.test(url.pathname) && !url.search && !url.hash,
  'Expected a fresh loopback admin merchant test database');
  process.env.DATABASE_URL = databaseUrl;
  process.env.JWT_SECRET = randomBytes(32).toString('base64url');
  process.env.WEB_BASE_URL = 'https://demo.example.test';
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
  const base = await app.getUrl();

  function request(method, path, { body, token, key } = {}) {
    return fetch(`${base}/api/v1/${path}`, { method, headers: {
      ...(body !== undefined && { 'content-type': 'application/json' }), ...(token && { authorization: `Bearer ${token}` }),
      ...(key && { 'Idempotency-Key': key }),
    }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(8000) });
  }
  async function read(response, status) {
    assert.equal(response.status, status);
    return response.json();
  }
  async function fail(response, status, code) {
    const value = await read(response, status);
    assert.deepEqual(Object.keys(value).sort(), ['code', 'message', 'statusCode']);
    assert.equal(value.statusCode, status);
    assert.equal(value.code, code);
  }

  const password = randomBytes(24).toString('base64url');
  const admin = await db.user.create({ data: { phone: '0999180001', name: 'Fixture admin', isAdmin: true, passwordHash: await bcrypt.hash(password, 10) } });
  const adminSession = await read(await request('POST', 'auth/admin/login', { body: { phone: admin.phone, password } }), 200);
  const register = (suffix, roles) => request('POST', 'auth/register', { body: {
    phone: `099918000${suffix}`, name: `Fixture ${suffix}`, password, roles,
    ...(roles.includes('merchant') && { shop: { name: `Shop ${suffix}`, details: 'Fixture shop' } }),
  } }).then((response) => read(response, 201));
  const multi = await register(2, ['customer', 'merchant', 'marketer']);
  const seller = await register(3, ['merchant']);
  const customerMerchant = await register(4, ['merchant', 'customer']);
  const contested = await register(5, ['merchant']);
  const marketer = await register(6, ['marketer']);
  const adminToken = adminSession.accessToken;
  const path = 'admin/merchants';
  const list = (search = '', token = adminToken) => request('GET', `${path}${search}`, { token });
  const decide = (id, body, token = adminToken) => request('PATCH', `${path}/${id}/verification`, { token, body });
  const wallet = (id, role) => db.wallet.findUniqueOrThrow({ where: { userId_role: { userId: id, role } } });
  const launch = (actor, productName) => request('POST', 'merchant/campaigns', { token: actor.accessToken, key: randomUUID(), body: {
    campaignType: 'product', productName, description: 'Fixture product', imageUrl: 'https://demo.example.test/box.jpg',
    originalPriceSyp: 100000, discountPercent: 10, commission: { type: 'fixed', amountSyp: 10000 }, maxItems: 3,
    joinMode: 'open', endsAt: new Date(Date.now() + 3600000).toISOString(),
  } });
  const financialSnapshot = () => db.$transaction([
    db.wallet.findMany({ orderBy: { id: 'asc' } }), db.customerProfile.findMany({ orderBy: { userId: 'asc' } }),
    db.campaign.findMany({ orderBy: { id: 'asc' } }), db.moneyMovement.findMany({ orderBy: { id: 'asc' } }),
    db.merchantTopup.count(), db.sale.count(), db.idempotencyRecord.count(),
  ]);
  const fund = (id, role, amount) => db.wallet.update({ where: { userId_role: { userId: id, role } }, data: { availableBalanceSyp: amount } });
  await fund(seller.user.id, 'merchant', 100000n);
  await fund(multi.user.id, 'merchant', 100000n);
  await fund(multi.user.id, 'marketer', 7000n);
  const sameTime = new Date(Date.now() - 60000);
  await db.user.updateMany({ where: { id: { in: [multi.user.id, seller.user.id, customerMerchant.user.id, contested.user.id] } }, data: { createdAt: sameTime } });
  let sellerCampaign;
  let otherReferral;

  await t.test('admin listing uses exact fields, defaults and ID tie-breaker and includes a multi-role merchant once', async () => {
    const response = await list();
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const result = await read(response, 200);
    const ids = [multi, seller, customerMerchant, contested].map(({ user }) => user.id).sort().reverse();
    assert.deepEqual({ ...result, items: result.items.map(({ id }) => id) }, { items: ids, page: 1, pageSize: 20,
      total: 4, previousPage: null, nextPage: null });
    const item = result.items.find(({ id }) => id === multi.user.id);
    assert.deepEqual(Object.keys(item).sort(), ['createdAt', 'id', 'merchant', 'name', 'phone', 'roles', 'wallet']);
    assert.deepEqual(item.roles, ['customer', 'marketer', 'merchant']);
    assert.deepEqual(item.merchant, { name: 'Shop 2', details: 'Fixture shop', verificationStatus: 'pending', contractReference: null });
    assert.deepEqual(item.wallet, { availableBalanceSyp: 100000, totalLockedReservesSyp: 0, creditLimitSyp: 0 });
    const page = await read(await list('?verificationStatus=pending&page=2&pageSize=1'), 200);
    assert.deepEqual({ ...page, items: page.items.map(({ id }) => id) }, { items: [ids[1]], page: 2, pageSize: 1,
      total: 4, previousPage: 1, nextPage: 3 });
    assert.deepEqual((await read(await list('?page=5&pageSize=1'), 200)).items, []);
    assert.equal((await read(await list('?verificationStatus=verified'), 200)).total, 0);
  });

  await t.test('both routes enforce admin access, validation, and merchant profile existence', async () => {
    await fail(await request('GET', path), 401, 'AUTH_REQUIRED');
    await fail(await request('PATCH', `${path}/${multi.user.id}/verification`, { body: { status: 'verified' } }), 401, 'AUTH_REQUIRED');
    await fail(await list('', multi.accessToken), 403, 'FORBIDDEN');
    await fail(await decide(multi.user.id, { status: 'verified' }, multi.accessToken), 403, 'FORBIDDEN');
    await fail(await list('?page=0'), 400, 'VALIDATION_ERROR');
    await fail(await list('?pageSize=101'), 400, 'VALIDATION_ERROR');
    await fail(await list('?verificationStatus=unknown'), 400, 'VALIDATION_ERROR');
    await fail(await decide('not-a-uuid', { status: 'verified' }), 400, 'VALIDATION_ERROR');
    await fail(await decide(randomUUID(), { status: 'verified' }), 404, 'NOT_FOUND');
    await fail(await decide(marketer.user.id, { status: 'verified' }), 404, 'NOT_FOUND');
    for (const body of [{ status: 'pending' }, { status: 'verified', contractReference: null }, { status: 'verified', availableBalanceSyp: 1 }]) {
      await fail(await decide(multi.user.id, body), 400, 'VALIDATION_ERROR');
    }
  });

  await t.test('approval is explicit, preserves an omitted reference, and permits an affordable launch', async () => {
    await fail(await launch(seller, 'Pending launch'), 403, 'MERCHANT_NOT_VERIFIED');
    const before = await financialSnapshot();
    const approved = await read(await decide(seller.user.id, { status: 'verified', contractReference: 'CASE-003' }), 200);
    assert.equal(approved.id, seller.user.id);
    assert.equal(approved.merchant.verificationStatus, 'verified');
    assert.equal(approved.merchant.contractReference, 'CASE-003');
    assert.deepEqual(await read(await decide(seller.user.id, { status: 'verified' }), 200), approved);
    await fail(await decide(seller.user.id, { status: 'rejected', contractReference: 'ignored' }), 409, 'INVALID_STATUS_TRANSITION');
    assert.deepEqual(await financialSnapshot(), before);
    sellerCampaign = await read(await launch(seller, 'Verified launch'), 201);
    await read(await launch(seller, 'Another verified launch'), 201);
    const verified = await read(await list('?verificationStatus=verified'), 200);
    assert.equal(verified.total, 1);
    assert.deepEqual(verified.items[0].wallet, { availableBalanceSyp: 13000, totalLockedReservesSyp: 87000, creditLimitSyp: 0 });
    assert.equal(verified.items[0].merchant.contractReference, 'CASE-003');
  });

  await t.test('a pending multi-role merchant can join and receive a customer pass', async () => {
    const join = async (token) => read(await request('POST', `marketer/campaigns/${sellerCampaign.id}/join`, { token }), 201);
    assert.equal((await join(multi.accessToken)).status, 'approved');
    const otherMembership = await join(marketer.accessToken);
    otherReferral = new URL(otherMembership.referralUrl).pathname.split('/').at(-1);
    assert.equal((await read(await request('POST', `customer/referrals/${otherReferral}/offer-qr`, { token: multi.accessToken }), 201)).status, 'active');
    await fail(await launch(multi, 'Still pending'), 403, 'MERCHANT_NOT_VERIFIED');
  });

  await t.test('rejection preserves existing roles and financial records and denies campaign launch', async () => {
    const before = await financialSnapshot();
    const denied = await read(await decide(multi.user.id, { status: 'rejected' }), 200);
    assert.deepEqual(denied.roles, multi.user.roles);
    assert.equal(denied.merchant.verificationStatus, 'rejected');
    assert.equal(denied.merchant.contractReference, null);
    assert.deepEqual(await read(await decide(multi.user.id, { status: 'rejected' }), 200), denied);
    assert.deepEqual(await financialSnapshot(), before);
    await fail(await launch(multi, 'Rejected launch'), 403, 'MERCHANT_NOT_VERIFIED');
    const me = await read(await request('GET', 'auth/me', { token: multi.accessToken }), 200);
    assert.equal(me.merchant.verificationStatus, 'rejected');
    assert.deepEqual(me.roles, multi.user.roles);
    assert.equal((await read(await request('GET', 'marketer/memberships', { token: multi.accessToken }), 200)).total, 1);
    await read(await request('POST', `customer/referrals/${otherReferral}/offer-qr`, { token: multi.accessToken }), 200);
    assert.equal((await read(await list('?verificationStatus=rejected'), 200)).items[0].id, multi.user.id);
    assert.equal((await wallet(multi.user.id, 'marketer')).availableBalanceSyp, 7000n);
  });

  await t.test('conflicting concurrent decisions commit one status and reference without financial writes', async () => {
    const before = await financialSnapshot();
    const decisions = [{ status: 'verified', contractReference: 'APPROVE' }, { status: 'rejected', contractReference: 'REJECT' }];
    const responses = await Promise.all(decisions.map((body) => decide(contested.user.id, body)));
    assert.deepEqual(responses.map(({ status }) => status).sort(), [200, 409]);
    const winner = responses.findIndex(({ status }) => status === 200);
    const result = await read(responses[winner], 200);
    await fail(responses[1 - winner], 409, 'INVALID_STATUS_TRANSITION');
    assert.equal(result.merchant.verificationStatus, decisions[winner].status);
    assert.equal(result.merchant.contractReference, decisions[winner].contractReference);
    assert.deepEqual(await read(await decide(contested.user.id, { status: decisions[winner].status }), 200), result);
    assert.deepEqual(await financialSnapshot(), before);
  });

  await t.test('Swagger publishes admin Bearer auth, query parameters, exact response shapes and decision errors', async () => {
    const docs = await read(await fetch(`${base}/api/docs-json`, { signal: AbortSignal.timeout(5000) }), 200);
    const merchantList = docs.paths['/api/v1/admin/merchants'].get;
    const verification = docs.paths['/api/v1/admin/merchants/{merchantId}/verification'].patch;
    for (const operation of [merchantList, verification]) assert.deepEqual(operation.security, [{ bearer: [] }]);
    assert.deepEqual(merchantList.parameters.map(({ name }) => name).sort(), ['page', 'pageSize', 'verificationStatus']);
    assert.equal(merchantList.responses['200'].content['application/json'].schema.$ref, '#/components/schemas/AdminMerchantPageDto');
    assert.equal(verification.requestBody.content['application/json'].schema.$ref, '#/components/schemas/VerifyMerchantDto');
    assert.equal(verification.responses['200'].content['application/json'].schema.$ref, '#/components/schemas/AdminMerchantDto');
    assert.match(verification.responses['409'].description, /INVALID_STATUS_TRANSITION/);
    const schemas = docs.components.schemas;
    assert.deepEqual(Object.keys(schemas.AdminMerchantDto.properties).sort(), ['createdAt', 'id', 'merchant', 'name', 'phone', 'roles', 'wallet']);
    assert.deepEqual(schemas.VerifyMerchantDto.properties.status.enum, ['verified', 'rejected']);
    assert.match(schemas.AdminMerchantWalletDto.properties.totalLockedReservesSyp.description, /hundredths of one new Syrian Pound/);
    assert.ok(docs.paths['/api/v1/auth/register'].post);
  });
});
