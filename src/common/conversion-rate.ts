export function campaignConversionRate(itemsSold: number, clicks: number): number {
  if (clicks === 0) return 0;
  const count = BigInt(clicks);
  return Number((BigInt(itemsSold) * 10000n + count / 2n) / count) / 100;
}
