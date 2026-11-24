const assert = require('node:assert/strict');
const test = require('node:test');
const { createHash, randomBytes } = require('node:crypto');
const { URL } = require('node:url');
const { plainToInstance } = require('class-transformer');
const { validate } = require('class-validator');
const { JwtService } = require('@nestjs/jwt');
const bcrypt = require('bcrypt');
const { RegisterDto } = require('../dist/auth/dto/register.dto');

const databaseUrl = process.env.REGISTRATION_INTEGRATION_DATABASE_URL;
const registration = (overrides = {}) => ({
  phone: '0999170001',
  name: 'Registration test account',
  password: randomBytes(24).toString('base64url'),
  roles: ['customer', 'merchant', 'marketer'],
  shop: { name: 'Test shop', details: 'Test details' },
  ...overrides,
});

test('registration DTO validates public roles, merchant shop and bcrypt byte limit', async () => {
  const options = { whitelist: true, forbidNonWhitelisted: true };
  const errors = (input) => validate(plainToInstance(RegisterDto, input), options);
  assert.deepEqual(await errors(registration()), []);
  assert.deepEqual(await errors(registration({ roles: ['customer'], shop: undefined })), []);
  for (const overrides of [
    { phone: '+963999170001' }, { phone: undefined }, { password: '' },
    { password: undefined }, { password: '\u00e9'.repeat(37) }, { name: undefined },
    { name: '   ' }, { roles: undefined }, { roles: [] }, { roles: ['customer', 'customer'] },
    { roles: ['admin'] }, { roles: ['other'] }, { shop: undefined }, { shop: null },
    { shop: { name: 'Sample' } }, { shop: { name: 'Sample', details: 'Details', verificationStatus: 'verified' } },
    { isAdmin: true },
  ]) {
    assert.ok((await errors(registration(overrides))).length > 0);
  }
});

test('Step 04D registration HTTP and PostgreSQL integration', { skip: !databaseUrl }, async (t) => {
  const url = new URL(databaseUrl);
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol) &&
    ['127.0.0.1', '[::1]'].includes(url.hostname) &&
    /^\/affiliate_marketing_registration_test_[a-z0-9_]+$/.test(url.pathname) &&
    !url.search && !url.hash, 'Expected a dedicated loopback registration-test database');

  const secret = randomBytes(32).toString('base64url');
  process.env.JWT_SECRET = secret;
  process.env.DATABASE_URL = databaseUrl;
  const { createApp } = require('../dist/main');
  const { PrismaService } = require('../dist/prisma/prisma.service');
  const app = await createApp({ logger: false });
  t.after(() => app.close());
  const client = app.get(PrismaService).getClient();
  const [identity] = await client.$queryRaw`SELECT current_database() AS db, host(inet_server_addr()) AS host`;
  assert.equal(identity.db, url.pathname.slice(1));
  assert.ok(['127.0.0.1', '::1'].includes(identity.host));
  assert.equal(await client.user.count(), 0, 'Expected a fresh database without users');
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  const post = (route, body) => fetch(`${base}/api/v1/auth/${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const expectError = async (response, status, code) => {
    assert.equal(response.status, status);
    const body = await response.json();
    assert.equal(body.statusCode, status);
    assert.equal(body.code, code);
    assert.equal(typeof body.message, 'string');
  };
  const input = registration();

  await t.test('registration starts a session and creates only the requested profiles and zero-balance wallets', async () => {
    const response = await post('register', input);
    assert.equal(response.status, 201);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const session = await response.json();
    assert.deepEqual(Object.keys(session).sort(), ['accessToken', 'expiresInSeconds', 'refreshToken', 'user']);
    assert.deepEqual(Object.keys(session.user).sort(), ['createdAt', 'customer', 'id', 'merchant', 'name', 'phone', 'roles']);
    assert.equal(session.expiresInSeconds, 1800);
    assert.equal(session.user.name, input.name);
    assert.equal(session.user.phone, input.phone);
    assert.deepEqual(session.user.roles, ['customer', 'marketer', 'merchant']);
    assert.deepEqual(session.user.merchant, { ...input.shop, verificationStatus: 'pending', contractReference: null });
    assert.deepEqual(session.user.customer, { verifiedPurchaseCount: 0, availableCashbackSyp: 0, lockedCashbackSyp: 0 });
    const record = await client.user.findUniqueOrThrow({
      where: { phone: input.phone }, include: { wallets: { orderBy: { role: 'asc' } }, sessions: true },
    });
    assert.equal(record.isAdmin, false);
    assert.equal(bcrypt.getRounds(record.passwordHash), 10);
    assert.ok(await bcrypt.compare(input.password, record.passwordHash));
    assert.deepEqual(record.wallets.map((wallet) => [wallet.role, wallet.availableBalanceSyp, wallet.pendingPayoutSyp]), [
      ['merchant', 0n, 0n], ['marketer', 0n, 0n],
    ]);
    assert.equal(record.sessions.length, 1);
    const [storedSession] = record.sessions;
    assert.equal(storedSession.refreshTokenHash, createHash('sha256').update(session.refreshToken).digest('hex'));
    const claims = await app.get(JwtService).verifyAsync(session.accessToken, { secret, algorithms: ['HS256'] });
    assert.equal(claims.sid, storedSession.id);
    assert.equal(claims.exp - claims.iat, 1800);
    const me = await fetch(`${base}/api/v1/auth/me`, { headers: { authorization: `Bearer ${session.accessToken}` } });
    assert.equal(me.status, 200);
    assert.deepEqual(await me.json(), session.user);
    const login = await post('login', { phone: input.phone, password: input.password });
    assert.equal(login.status, 200);
    assert.deepEqual((await login.json()).user, session.user);
  });

  await t.test('invalid payloads use the existing error envelope', async () => {
    await expectError(await post('register', { ...input, roles: ['admin'] }), 400, 'VALIDATION_ERROR');
    await expectError(await post('register', { ...input, shop: undefined }), 400, 'VALIDATION_ERROR');
  });

  await t.test('duplicate phone returns 409 without creating an extra session', async () => {
    const user = await client.user.findUniqueOrThrow({ where: { phone: input.phone } });
    const where = { userId: user.id };
    const sessions = await client.userSession.count({ where });
    await expectError(await post('register', input), 409, 'PHONE_ALREADY_REGISTERED');
    assert.equal(await client.userSession.count({ where }), sessions);
  });

  await t.test('concurrent requests for a phone create one user, profile set and session', async () => {
    const shared = registration({ phone: '0999170002' });
    const responses = await Promise.all([post('register', shared), post('register', shared)]);
    assert.deepEqual(responses.map((response) => response.status).sort(), [201, 409]);
    await expectError(responses.find((response) => response.status === 409), 409, 'PHONE_ALREADY_REGISTERED');
    assert.equal(await client.user.count({ where: { phone: shared.phone } }), 1);
    const { id: userId } = await client.user.findUniqueOrThrow({ where: { phone: shared.phone } });
    assert.equal(await client.userSession.count({ where: { userId } }), 1);
    assert.equal(await client.merchantProfile.count({ where: { userId } }), 1);
    assert.equal(await client.customerProfile.count({ where: { userId } }), 1);
    assert.equal(await client.wallet.count({ where: { userId } }), 2);
  });

  await t.test('session failure rolls back account, profiles and wallets, then retry can succeed', async () => {
    const retryable = registration({ phone: '0999170003' });
    const counts = () => Promise.all([
      client.user.count(), client.userSession.count(), client.merchantProfile.count(),
      client.customerProfile.count(), client.wallet.count(),
    ]);
    const before = await counts();
    const jwt = app.get(JwtService);
    const sign = t.mock.method(jwt, 'signAsync', async () => { throw new Error('Synthetic signing failure'); });
    try {
      await expectError(await post('register', retryable), 500, 'INTERNAL_ERROR');
      assert.deepEqual(await counts(), before);
    } finally {
      sign.mock.restore();
    }
    assert.equal((await post('register', retryable)).status, 201);
  });

  await t.test('customer-only registration has a customer profile and no merchant or marketer wallet', async () => {
    const customer = registration({ phone: '0999170004', roles: ['customer'], shop: undefined });
    const response = await post('register', customer);
    assert.equal(response.status, 201);
    const { user } = await response.json();
    assert.deepEqual(user.roles, ['customer']);
    assert.equal(user.merchant, null);
    assert.ok(user.customer);
    assert.equal(await client.wallet.count({ where: { userId: user.id } }), 0);
  });

  await t.test('Swagger documents the public registration request, success and errors', async () => {
    const response = await fetch(`${base}/api/docs-json`);
    assert.equal(response.status, 200);
    const docs = await response.json();
    const route = docs.paths['/api/v1/auth/register'].post;
    assert.equal(route.security, undefined);
    assert.equal(route.requestBody.content['application/json'].schema.$ref, '#/components/schemas/RegisterDto');
    assert.equal(route.responses['201'].content['application/json'].schema.$ref, '#/components/schemas/AuthSessionDto');
    for (const status of ['400', '409', '429', '500']) assert.ok(route.responses[status]);
    assert.equal(route.responses['409'].description, 'PHONE_ALREADY_REGISTERED');
    const schema = docs.components.schemas.RegisterDto;
    assert.deepEqual(schema.required.sort(), ['name', 'password', 'phone', 'roles']);
    assert.deepEqual(schema.properties.roles.items.enum, ['customer', 'marketer', 'merchant']);
    assert.match(schema.properties.shop.description, /Required when roles includes merchant/);
  });
});
