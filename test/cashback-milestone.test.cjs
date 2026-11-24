const assert = require('node:assert/strict');
const test = require('node:test');
const { accrueCashback } = require('../dist/scanner/cashback-milestone');

const progress = { verifiedPurchaseCount: 4, milestonePurchaseCount: 4, milestoneSpendSyp: 40000n,
  lockedCashbackSyp: 800n, availableCashbackSyp: 100n };

test('cashback requires both thresholds and unlocks the whole cycle once', () => {
  const below = accrueCashback(progress, 5000n, 100n, 5, 50000n);
  assert.equal(below.unlockedSyp, 0n);
  assert.equal(below.update.lockedCashbackSyp, 900n);
  const unlocked = accrueCashback(below.update, 5000n, 100n, 5, 50000n);
  assert.deepEqual(unlocked, { unlockedSyp: 1000n, update: { verifiedPurchaseCount: 6, milestonePurchaseCount: 0,
    milestoneSpendSyp: 0n, lockedCashbackSyp: 0n, availableCashbackSyp: 1100n } });
  const nextCycle = accrueCashback(unlocked.update, 90000n, 1800n, 5, 50000n);
  assert.equal(nextCycle.unlockedSyp, 0n);
  assert.equal(nextCycle.update.availableCashbackSyp, 1100n);
});

test('cashback checks exact money and PostgreSQL counter limits', () => {
  const limit = BigInt(Number.MAX_SAFE_INTEGER);
  assert.equal(accrueCashback({ ...progress, availableCashbackSyp: limit - 1000n }, 10000n, 200n, 5, 50000n)
    .update.availableCashbackSyp, limit);
  assert.throws(() => accrueCashback({ ...progress, availableCashbackSyp: limit - 999n }, 10000n, 200n, 5, 50000n), RangeError);
  assert.throws(() => accrueCashback({ ...progress, verifiedPurchaseCount: 2147483647 }, 10000n, 200n, 5, 50000n), RangeError);
});
