const assert = require('node:assert/strict');
const test = require('node:test');
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const { JwtService } = require('@nestjs/jwt');
const bcrypt = require('bcrypt');

const secret = randomBytes(32).toString('base64url');
process.env.JWT_SECRET = secret;
process.env.DATABASE_URL = 'postgresql://offline@127.0.0.1:1/auth_unit_test';
const { createApp } = require('../dist/main');
const { PrismaService } = require('../dist/prisma/prisma.service');

test('Step 04A login HTTP contract', async (t) => {
  const password = randomBytes(18).toString('base64url');
  const passwordHash = await bcrypt.hash(password, 10);
  const createdAt = new Date('2026-01-01T00:00:00Z');
  const regular = {
    id: randomUUID(),
    name: 'Test account',
    phone: '0999100002',
    passwordHash,
    createdAt,
    isAdmin: false,
    isCustomer: true,
    isMarketer: true,
    merchantProfile: {
      shopName: 'Test shop',
      shopDetails: 'Test details',
      verificationStatus: 'verified',
      contractReference: null,
    },
    customerProfile: { verifiedPurchaseCount: 4, availableCashbackSyp: 500n, lockedCashbackSyp: 1800n },
  };
  const admin = {
    ...regular,
    id: randomUUID(),
    phone: '0999100001',
    isAdmin: true,
    isCustomer: false,
    isMarketer: false,
    merchantProfile: null,
    customerProfile: null,
  };
  const accounts = new Map([regular, admin].map((account) => [account.phone, account]));
  const persistedSessions = [];
  let rejectSession = false;

  const app = await createApp({ logger: false });
  t.after(() => app.close());
  const prisma = app.get(PrismaService);
  prisma.onModuleInit = async () => {};
  prisma.getClient = () => ({
    user: { findUnique: async ({ where }) => accounts.get(where.phone) },
    userSession: { create: async ({ data }) => {
      if (rejectSession) throw new Error('Private database failure');
      persistedSessions.push(data);
      return { id: data.id };
    } },
  });
  await app.listen(0, '127.0.0.1');
  const baseUrl = await app.getUrl();
  const post = (route, body) => fetch(`${baseUrl}/api/v1/auth/${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const credentials = (account) => ({ phone: account.phone, password });
  const invalidCredentials = { statusCode: 401, code: 'INVALID_CREDENTIALS', message: 'Invalid phone number or password.' };

  await t.test('regular login maps the Account, signs a 30-minute JWT, and stores only the refresh hash', async () => {
    const response = await post('login', credentials(regular));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json();
    assert.deepEqual(Object.keys(body).sort(), ['accessToken', 'expiresInSeconds', 'refreshToken', 'user']);
    assert.equal(body.expiresInSeconds, 1800);
    assert.deepEqual(body.user, {
      id: regular.id,
      name: regular.name,
      phone: regular.phone,
      roles: ['customer', 'marketer', 'merchant'],
      createdAt: createdAt.toISOString(),
      merchant: { name: 'Test shop', details: 'Test details', verificationStatus: 'verified', contractReference: null },
      customer: { verifiedPurchaseCount: 4, availableCashbackSyp: 500, lockedCashbackSyp: 1800 },
    });
    const payload = await new JwtService().verifyAsync(body.accessToken, { secret, algorithms: ['HS256'] });
    const [session] = persistedSessions;
    assert.deepEqual(Object.keys(payload).sort(), ['exp', 'iat', 'jti', 'roles', 'sid', 'sub']);
    assert.equal(payload.sub, regular.id);
    assert.equal(payload.sid, session.id);
    assert.deepEqual(payload.roles, body.user.roles);
    assert.equal(payload.exp - payload.iat, 1800);
    assert.match(body.refreshToken, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(session.refreshTokenHash, createHash('sha256').update(body.refreshToken).digest('hex'));
    assert.ok(!JSON.stringify(session).includes(body.refreshToken));
    assert.equal(session.userId, regular.id);
    assert.equal(session.createdAt.getTime(), session.lastActivityAt.getTime());
    assert.equal(session.expiresAt - session.lastActivityAt, 30 * 24 * 60 * 60 * 1000);
  });

  await t.test('admin login succeeds with the database role and nullable profiles', async () => {
    const response = await post('admin/login', credentials(admin));
    assert.equal(response.status, 200);
    const { user } = await response.json();
    assert.deepEqual(user.roles, ['admin']);
    assert.equal(user.merchant, null);
    assert.equal(user.customer, null);
  });

  await t.test('wrong password, unknown phone and wrong login route receive the same 401', async () => {
    for (const [route, body] of [
      ['login', { ...credentials(regular), password: password + '-wrong' }],
      ['login', { phone: '0999100099', password }],
      ['admin/login', credentials(regular)],
      ['login', credentials(admin)],
    ]) {
      const response = await post(route, body);
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), invalidCredentials);
    }
    assert.equal(persistedSessions.length, 2);
  });

  await t.test('invalid phone, missing password, oversized password and injected roles are rejected', async () => {
    for (const body of [
      { phone: '123', password },
      { phone: regular.phone },
      { ...credentials(regular), password: '\u00e9'.repeat(37) },
      { ...credentials(regular), roles: ['admin'] },
    ]) {
      const response = await post('login', body);
      assert.equal(response.status, 400);
      assert.equal((await response.json()).code, 'VALIDATION_ERROR');
    }
    assert.equal(persistedSessions.length, 2);
  });

  await t.test('malformed JSON returns the generic contract validation error', async () => {
    const response = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"password":SyntheticParserProbe42}',
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
      message: 'Invalid request payload.',
    });
    assert.equal(persistedSessions.length, 2);
  });

  await t.test('failed session persistence returns a generic error without tokens', async () => {
    rejectSession = true;
    const response = await post('login', credentials(regular));
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { statusCode: 500, code: 'INTERNAL_ERROR', message: 'Unable to sign in.' });
    assert.equal(persistedSessions.length, 2);
  });

  await t.test('login request limit returns the contract error', async () => {
    assert.equal((await post('login', credentials(regular))).status, 500);
    const response = await post('login', credentials(regular));
    assert.equal(response.status, 429);
    assert.equal((await response.json()).code, 'RATE_LIMITED');
  });

  await t.test('Swagger describes both login endpoints and their errors', async () => {
    const response = await fetch(`${baseUrl}/api/docs-json`);
    assert.equal(response.status, 200);
    const document = await response.json();
    const customer = document.components.schemas.CustomerAccountDto.properties;
    for (const field of ['availableCashbackSyp', 'lockedCashbackSyp']) {
      assert.equal(customer[field].type, 'integer');
      assert.equal(customer[field].minimum, 0);
      assert.equal(customer[field].maximum, Number.MAX_SAFE_INTEGER);
      assert.match(customer[field].description, /hundredths of one new Syrian Pound/);
    }
    for (const route of ['/api/v1/auth/login', '/api/v1/auth/admin/login']) {
      const operation = document.paths[route].post;
      assert.equal(operation.requestBody.content['application/json'].schema.$ref, '#/components/schemas/LoginDto');
      assert.equal(operation.responses['200'].content['application/json'].schema.$ref, '#/components/schemas/AuthSessionDto');
      for (const status of ['400', '401', '429', '500']) {
        assert.equal(operation.responses[status].content['application/json'].schema.$ref, '#/components/schemas/AuthErrorDto');
      }
    }
  });
});
