const assert = require('node:assert/strict');
const test = require('node:test');
const { readPage } = require('../dist/common/pagination');
const { ReportingService } = require('../dist/reporting/reporting.service');

test('reporting pagination calculates slice and navigation and avoids out-of-range offsets', async () => {
  const read = async (skip, take) => [skip, take];
  assert.deepEqual(await readPage({ page: 2, pageSize: 2 }, 5, read),
    { items: [2, 2], page: 2, pageSize: 2, total: 5, previousPage: 1, nextPage: 3 });
  const neverRead = async () => assert.fail('No rows should be fetched for this page');
  assert.deepEqual(await readPage({ page: 1, pageSize: 20 }, 0, neverRead),
    { items: [], page: 1, pageSize: 20, total: 0, previousPage: null, nextPage: null });
  assert.deepEqual(await readPage({ page: Number.MAX_SAFE_INTEGER, pageSize: 100 }, 3, neverRead),
    { items: [], page: Number.MAX_SAFE_INTEGER, pageSize: 100, total: 3,
      previousPage: Number.MAX_SAFE_INTEGER - 1, nextPage: null });
});

test('merchant reserve serialization preserves the safe limit and rejects overflow in a read-only transaction', async () => {
  let locked = '9007199254740991';
  const tx = {
    $executeRaw: async ([sql]) => assert.equal(sql, 'SET TRANSACTION READ ONLY'),
    $queryRaw: async () => [{ count: 2n, locked }],
    wallet: { findUniqueOrThrow: async ({ where }) => {
      assert.deepEqual(where, { userId_role: { userId: 'actor-id', role: 'merchant' } });
      return { availableBalanceSyp: 15n };
    } },
    merchantProfile: { findUniqueOrThrow: async () => ({ creditLimitSyp: 25n, verificationStatus: 'pending' }) },
  };
  const service = new ReportingService({ getClient: () => ({
    $transaction: (callback, options) => {
      assert.equal(options.isolationLevel, 'RepeatableRead');
      return callback(tx);
    },
  }) });
  assert.deepEqual(await service.merchantWallet('actor-id'),
    { availableBalanceSyp: 15, totalLockedReservesSyp: Number.MAX_SAFE_INTEGER, creditLimitSyp: 25 });
  locked = '9007199254740992';
  await assert.rejects(service.merchantWallet('actor-id'), (error) =>
    error.getStatus() === 409 && error.getResponse().code === 'AMOUNT_OUT_OF_RANGE');
});
