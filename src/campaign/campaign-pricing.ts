import { MAX_MONEY_MINOR_UNITS } from '../common/money';
import { MAX_POSTGRES_INT } from '../common/postgres-limits';

const FULL_RATE = 10_000n;
const PLATFORM_FEE = 500n;
const CASHBACK = 200n;
export const MAX_CAMPAIGN_ITEMS = MAX_POSTGRES_INT;

type Commission = { type: 'fixed'; amountSyp: bigint } | { type: 'percentage'; basisPoints: bigint };

export class InvalidCampaignPricingError extends Error {}
export class CampaignPricingOverflowError extends RangeError {}

export function percentToBasisPoints(percent: number): bigint {
  const parts = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(String(percent));
  if (!parts) throw new InvalidCampaignPricingError('Expected a percentage with up to two fractional digits.');
  const basisPoints = BigInt(parts[1]) * 100n + BigInt((parts[2] ?? '').padEnd(2, '0'));
  validateRate(basisPoints);
  return basisPoints;
}

function validateRate(basisPoints: bigint): void {
  if (basisPoints < 0n || basisPoints > FULL_RATE) {
    throw new InvalidCampaignPricingError('Percentage must be from 0 to 100.');
  }
}

function validateMoney(amount: bigint, minimum: bigint): void {
  if (amount < minimum || amount > MAX_MONEY_MINOR_UNITS) {
    throw new InvalidCampaignPricingError('Input amount is outside the supported range.');
  }
}

function validateQuantity(quantity: number): void {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_CAMPAIGN_ITEMS) {
    throw new InvalidCampaignPricingError('Item count is outside the supported range.');
  }
}

function checkedTotal(amount: bigint): bigint {
  if (amount > MAX_MONEY_MINOR_UNITS) {
    throw new CampaignPricingOverflowError('A calculated amount exceeds the supported range.');
  }
  return amount;
}

export function discountedPrice(originalPriceSyp: bigint, discountBasisPoints: bigint): bigint {
  validateMoney(originalPriceSyp, 1n);
  validateRate(discountBasisPoints);
  const finalPrice = originalPriceSyp * (FULL_RATE - discountBasisPoints) / FULL_RATE;
  if (finalPrice === 0n) throw new InvalidCampaignPricingError('The discounted price must remain positive.');
  return finalPrice;
}

export function calculateSalePricing(unitPriceSyp: bigint, commission: Commission, quantity: number) {
  validateMoney(unitPriceSyp, 1n);
  validateQuantity(quantity);
  const customerPaidCashSyp = checkedTotal(unitPriceSyp * BigInt(quantity));
  let marketerCommissionSyp: bigint;
  if (commission.type === 'fixed') {
    validateMoney(commission.amountSyp, 0n);
    marketerCommissionSyp = checkedTotal(commission.amountSyp * BigInt(quantity));
  } else {
    validateRate(commission.basisPoints);
    if (commission.basisPoints + PLATFORM_FEE >= FULL_RATE) {
      throw new InvalidCampaignPricingError('Percentage commission plus the platform fee must be below 100%.');
    }
    marketerCommissionSyp = customerPaidCashSyp * commission.basisPoints / FULL_RATE;
  }
  const platformTotalFeeSyp = customerPaidCashSyp * PLATFORM_FEE / FULL_RATE;
  const customerCashbackSyp = customerPaidCashSyp * CASHBACK / FULL_RATE;
  const platformNetFeeSyp = platformTotalFeeSyp - customerCashbackSyp;
  const merchantNetSyp = customerPaidCashSyp - marketerCommissionSyp - platformTotalFeeSyp;
  if (merchantNetSyp <= 0n) throw new InvalidCampaignPricingError('Merchant net must remain positive.');

  return { customerPaidCashSyp, marketerCommissionSyp, platformTotalFeeSyp, customerCashbackSyp, platformNetFeeSyp, merchantNetSyp };
}

export function calculateProductPricing(input: {
  originalPriceSyp: bigint;
  discountBasisPoints: bigint;
  commission: Commission;
  maxItems: number;
}) {
  validateQuantity(input.maxItems);
  const finalPriceSyp = discountedPrice(input.originalPriceSyp, input.discountBasisPoints);
  const sample = calculateSalePricing(finalPriceSyp, input.commission, 1);
  // The demo settles one item per sale, rounding each sale's fee before reserving for the full cap.
  const reservePerSale = sample.marketerCommissionSyp + sample.platformTotalFeeSyp;
  const worstCaseReserveSyp = checkedTotal(BigInt(input.maxItems) * reservePerSale);
  return { finalPriceSyp, sample, worstCaseReserveSyp };
}
