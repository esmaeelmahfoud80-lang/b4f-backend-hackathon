export const MAX_MONEY_MINOR_UNITS = 9_007_199_254_740_991n;

/** Serialize integer hundredths of one new Syrian Pound for the API. */
export function toMoneyJsonInteger(minorUnits: bigint): number {
  if (minorUnits < 0n || minorUnits > MAX_MONEY_MINOR_UNITS) {
    throw new RangeError('Money is outside the supported JSON integer range.');
  }
  return Number(minorUnits);
}
