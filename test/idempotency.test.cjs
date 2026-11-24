const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');
const { setTimeout } = require('node:timers/promises');
const { URL } = require('node:url');
const { PrismaPg } = require('@prisma/adapter-pg');
const { PrismaClient } = require('../dist/generated/prisma/client');
const { validateIdempotencyKey } = require('../dist/common/idempotency/idempotency-key');
const { IdempotencyService } = require('../dist/common/idempotency/idempotency.service');
const { requestFingerprint } = require('../dist/common/idempotency/request-fingerprint');

const isError = (status, code) => (e) => e.getStatus?.() === status && e.getResponse().code === code;
const databaseUrl = process.env.IDEMPOTENCY_INTEGRATION_DATABASE_URL;

test('idempotency key is a single UUID and its case is normalized', () => {
  const key = randomUUID();
  assert.equal(validateIdempotencyKey(key.toUpperCase()), key);
  for (const value of [undefined, '', 'not-a-uuid', ' '.repeat(40), [key], `${key},${key}`]) {
    assert.throws(() => validateIdempotencyKey(value), isError(400, 'VALIDATION_ERROR'));
  }
});

test('request fingerprint normalizes nested object keys and preserves array order and types', () => {
  const payload = { b: [{ two: 2, one: 1 }, true], a: 'demo' };
  assert.equal(requestFingerprint(payload), requestFingerprint({ a: 'demo', b: [{ one: 1, two: 2 }, true] }));
  assert.notEqual(requestFingerprint(payload), requestFingerprint({ ...payload, b: [...payload.b].reverse() }));
  assert.notEqual(requestFingerprint({ amount: 1 }), requestFingerprint({ amount: '1' }));
  assert.throws(() => requestFingerprint({ invalid: undefined }), TypeError);
});

test('shared idempotency on isolated PostgreSQL', { skip: !databaseUrl }, async (t) => {
  const url = new URL(databaseUrl);
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol) &&
    ['127.0.0.1', '[::1]'].includes(url.hostname) &&
    /^\/affiliate_marketing_idempotency_test_[a-z0-9_]+$/.test(url.pathname) &&
    !url.search && !url.hash, 'Expected a dedicated loopback idempotency-test database');
  const makeClient = () => new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 }),
  });
  const first = makeClient();
  const second = makeClient();
  t.after(() => Promise.all([first.$disconnect(), second.$disconnect()]));
  const [identity] = await first.$queryRaw`SELECT current_database() AS db, host(inet_server_addr()) AS host`;
  assert.equal(identity.db, url.pathname.slice(1));
  assert.ok(['127.0.0.1', '::1'].includes(identity.host));
  assert.equal(await first.user.count(), 0, 'Expected a fresh test database');

  const accounts = await first.user.createManyAndReturn({
    data: [
      { phone: '0999100011', name: 'Idempotency fixture A', passwordHash: 'unused-test-value' },
      { phone: '0999100012', name: 'Idempotency fixture B', passwordHash: 'unused-test-value' },
    ],
    select: { id: true },
  });
  const wallets = await first.wallet.createManyAndReturn({
    data: accounts.map(({ id }) => ({ userId: id, role: 'merchant' })),
    select: { id: true, userId: true },
  });
  const service = new IdempotencyService({ getClient: () => first });
  const otherInstance = new IdempotencyService({ getClient: () => second });
  const walletId = (actorId) => wallets.find((wallet) => wallet.userId === actorId).id;
  const balance = async (actorId) => (await first.wallet.findUniqueOrThrow({ where: { id: walletId(actorId) } })).availableBalanceSyp;
  const [a, b] = accounts.map(({ id }) => id);
  const request = (overrides = {}) => ({
    actorId: a, operation: 'test.credit', key: randomUUID(), payload: { amount: 1, target: walletId(a) },
    ...overrides,
  });
  const lookup = ({ actorId, operation, key }) => first.idempotencyRecord.findUnique({
    where: { actorId_operation_requestKey: { actorId, operation, requestKey: key } },
  });
  const mutation = (input) => async (tx) => {
    const amount = BigInt(input.payload.amount);
    const wallet = await tx.wallet.update({
      where: { id: walletId(input.actorId) },
      data: { availableBalanceSyp: { increment: amount } },
    });
    return { statusCode: 201, body: { amount: Number(amount), balance: Number(wallet.availableBalanceSyp) } };
  };
  const noReplayWork = async () => { assert.fail('Replay must not execute the callback'); };

  await t.test('first execution, saved response, replay and conflicting request', async () => {
    const input = request();
    const result = await service.execute(input, mutation(input));
    assert.deepEqual(result, { statusCode: 201, body: { amount: 1, balance: 1 } });
    const stored = await lookup(input);
    assert.equal(stored.responseStatus, result.statusCode);
    assert.deepEqual(stored.responseBody, result.body);
    assert.equal(stored.requestFingerprint, requestFingerprint(input.payload));
    const replay = await otherInstance.execute(
      { ...input, key: input.key.toUpperCase(), payload: { target: walletId(a), amount: 1 } },
      noReplayWork,
    );
    assert.deepEqual(replay, result);
    await assert.rejects(
      service.execute({ ...input, payload: { target: walletId(a), amount: 2 } }, noReplayWork),
      isError(409, 'IDEMPOTENCY_KEY_REUSED'),
    );
    assert.equal(await balance(a), 1n);
  });

  await t.test('different actors and operations can reuse a key', async () => {
    const input = request();
    const before = await balance(a);
    const otherActor = { ...input, actorId: b, payload: { amount: 1, target: walletId(b) } };
    const otherOperation = { ...input, operation: 'test.another-credit' };
    for (const scope of [input, otherActor, otherOperation]) {
      await service.execute(scope, mutation(scope));
      assert.ok(await lookup(scope));
    }
    assert.equal(await balance(a), before + 2n);
    assert.equal(await balance(b), 1n);
  });

  async function overlappingClaims(winner, contender) {
    let signalOwner;
    const claimed = new Promise((resolve) => { signalOwner = resolve; });
    let releaseOwner;
    const release = new Promise((resolve) => { releaseOwner = resolve; });
    let callbacks = 0;
    const ownerResult = service.execute(winner, async (tx) => {
      callbacks++;
      signalOwner();
      await release;
      return mutation(winner)(tx);
    });
    let results;
    try {
      await Promise.race([claimed, ownerResult]);
      results = Promise.allSettled([
        ownerResult,
        otherInstance.execute(contender, async (tx) => {
          callbacks++;
          return mutation(contender)(tx);
        }),
      ]);
      const deadline = Date.now() + 2000;
      let sawBlockedClaim = false;
      while (!sawBlockedClaim && Date.now() < deadline) {
        const [activity] = await first.$queryRaw`
          SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'
              AND query LIKE '%INSERT%idempotency_records%'
          ) AS blocked
        `;
        sawBlockedClaim = activity.blocked;
        if (!sawBlockedClaim) await setTimeout(20);
      }
      assert.ok(sawBlockedClaim, 'Expected the second database connection to wait on the claim');
    } finally {
      releaseOwner();
      await (results ?? ownerResult);
    }
    return { outcomes: await results, callbacks };
  }

  await t.test('overlapping requests on separate clients replay one execution', async () => {
    const input = request();
    const before = await balance(a);
    const { outcomes, callbacks } = await overlappingClaims(input, input);
    assert.equal(callbacks, 1);
    assert.equal(outcomes[0].status, 'fulfilled');
    assert.deepEqual(outcomes[1], outcomes[0]);
    assert.equal(await balance(a), before + 1n);
  });

  await t.test('overlapping different payloads return one success and one conflict', async () => {
    const input = request();
    const before = await balance(a);
    const { outcomes, callbacks } = await overlappingClaims(input, { ...input, payload: { ...input.payload, amount: 7 } });
    assert.equal(callbacks, 1);
    assert.equal(outcomes[0].status, 'fulfilled');
    assert.equal(outcomes[1].status, 'rejected');
    assert.ok(isError(409, 'IDEMPOTENCY_KEY_REUSED')(outcomes[1].reason));
    assert.equal(await balance(a), before + 1n);
  });

  await t.test('callback failure rolls back all writes and allows a retry', async () => {
    const input = request();
    const before = await balance(a);
    await assert.rejects(service.execute(input, async (tx) => {
      await mutation(input)(tx);
      throw new Error('Simulated mutation failure');
    }), isError(500, 'INTERNAL_ERROR'));
    assert.equal(await lookup(input), null);
    assert.equal(await balance(a), before);
    const retried = await otherInstance.execute(input, mutation(input));
    assert.equal(retried.statusCode, 201);
    assert.equal(await balance(a), before + 1n);
    assert.deepEqual(await service.execute(input, noReplayWork), retried);
  });
});
