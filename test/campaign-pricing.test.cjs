const assert = require('node:assert/strict');
const test = require('node:test');
const { MAX_MONEY_MINOR_UNITS } = require('../dist/common/money');
const {
  calculateProductPricing, calculateSalePricing, CampaignPricingOverflowError, discountedPrice,
  InvalidCampaignPricingError, MAX_CAMPAIGN_ITEMS, percentToBasisPoints,
} = require('../dist/campaign/campaign-pricing');

const input = {
  originalPriceSyp: 100000n, discountBasisPoints: 1000n,
  commission: { type: 'fixed', amountSyp: 10000n }, maxItems: 30,
};

test('demo product preview reconciles the fixed commission, sale splits, merchant net, and reserve', () => {
  assert.deepEqual(calculateProductPricing(input), {
    finalPriceSyp: 90000n,
    sample: {
      customerPaidCashSyp: 90000n, marketerCommissionSyp: 10000n, platformTotalFeeSyp: 4500n,
      customerCashbackSyp: 1800n, platformNetFeeSyp: 2700n, merchantNetSyp: 75500n,
    },
    worstCaseReserveSyp: 435000n,
  });
  assert.equal(calculateSalePricing(90n, { type: 'fixed', amountSyp: 10n }, 3).marketerCommissionSyp, 30n);
});

test('exact basis points and floors preserve the fee split at fractional minor-unit boundaries', () => {
  assert.equal(percentToBasisPoints(9.99), 999n);
  assert.equal(percentToBasisPoints(100), 10000n);
  assert.equal(discountedPrice(110n, 999n), 99n);
  assert.equal(discountedPrice(101n, 1000n), 90n);
  const split = calculateSalePricing(49n, { type: 'percentage', basisPoints: percentToBasisPoints(33.33) }, 1);
  assert.deepEqual(split, {
    customerPaidCashSyp: 49n, marketerCommissionSyp: 16n, platformTotalFeeSyp: 2n,
    customerCashbackSyp: 0n, platformNetFeeSyp: 2n, merchantNetSyp: 31n,
  });
  assert.equal(split.platformTotalFeeSyp, split.platformNetFeeSyp + split.customerCashbackSyp);
  assert.equal(split.customerPaidCashSyp, split.merchantNetSyp + split.marketerCommissionSyp + split.platformTotalFeeSyp);
  assert.equal(calculateProductPricing({ ...input, originalPriceSyp: 39n, discountBasisPoints: 0n,
    commission: { type: 'fixed', amountSyp: 0n }, maxItems: 2 }).worstCaseReserveSyp, 2n);
});

test('rejects out-of-range prices, percentages, quantities, and commission economics', () => {
  for (const rate of [-1, 100.01, 1.001, 1e-7, Infinity, NaN]) {
    assert.throws(() => percentToBasisPoints(rate), InvalidCampaignPricingError);
  }
  for (const overrides of [
    { originalPriceSyp: 0n }, { originalPriceSyp: -1n }, { originalPriceSyp: MAX_MONEY_MINOR_UNITS + 1n },
    { originalPriceSyp: 1n, discountBasisPoints: 1n }, { discountBasisPoints: 10000n },
    { maxItems: 0 }, { maxItems: MAX_CAMPAIGN_ITEMS + 1 }, { maxItems: 1.5 },
    { commission: { type: 'fixed', amountSyp: -1n } }, { commission: { type: 'fixed', amountSyp: 85500n } },
    { commission: { type: 'percentage', basisPoints: 9500n } },
  ]) {
    assert.throws(() => calculateProductPricing({ ...input, ...overrides }), InvalidCampaignPricingError);
  }
});

test('keeps in-range results exact and rejects derived overflow', () => {
  const boundary = { originalPriceSyp: MAX_MONEY_MINOR_UNITS, discountBasisPoints: 0n,
    commission: { type: 'fixed', amountSyp: 0n } };
  const result = calculateProductPricing({ ...boundary, maxItems: 20 });
  assert.equal(result.finalPriceSyp, MAX_MONEY_MINOR_UNITS);
  assert.equal(result.worstCaseReserveSyp, 9007199254740980n);
  assert.throws(() => calculateProductPricing({ ...boundary, maxItems: 21 }), CampaignPricingOverflowError);
  assert.throws(() => calculateSalePricing(MAX_MONEY_MINOR_UNITS, boundary.commission, 2), CampaignPricingOverflowError);
});
