const assert = require('node:assert/strict');
const test = require('node:test');
const { MAX_MONEY_MINOR_UNITS, toMoneyJsonInteger } = require('../dist/common/money');

test('money serializes as safe minor-unit integers without rescaling', () => {
  for (const amount of [0n, 1n, 100_000n, MAX_MONEY_MINOR_UNITS]) {
    const serialized = JSON.parse(JSON.stringify(toMoneyJsonInteger(amount)));
    assert.ok(Number.isSafeInteger(serialized));
    assert.equal(BigInt(serialized), amount);
  }
  const example = BigInt(toMoneyJsonInteger(100_000n));
  const displayed = `${example / 100n}.${String(example % 100n).padStart(2, '0')}`;
  assert.equal(displayed, '1000.00');
});

test('money serialization rejects negative and overflowing bigint amounts', () => {
  assert.equal(MAX_MONEY_MINOR_UNITS, BigInt(Number.MAX_SAFE_INTEGER));
  assert.throws(() => toMoneyJsonInteger(-1n), RangeError);
  assert.throws(() => toMoneyJsonInteger(MAX_MONEY_MINOR_UNITS + 1n), RangeError);
});
