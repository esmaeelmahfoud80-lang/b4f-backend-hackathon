import { MAX_POSTGRES_INT } from '../common/postgres-limits';
import { MAX_MONEY_MINOR_UNITS } from '../common/money';

type Progress = {
  verifiedPurchaseCount: number;
  milestonePurchaseCount: number;
  milestoneSpendSyp: bigint;
  lockedCashbackSyp: bigint;
  availableCashbackSyp: bigint;
};

export function accrueCashback(progress: Progress, cash: bigint, cashback: bigint, minimumPurchases: number, minimumSpendSyp: bigint) {
  const verifiedPurchaseCount = progress.verifiedPurchaseCount + 1;
  const milestonePurchaseCount = progress.milestonePurchaseCount + 1;
  const milestoneSpendSyp = progress.milestoneSpendSyp + cash;
  const lockedCashbackSyp = progress.lockedCashbackSyp + cashback;
  const unlocked = milestonePurchaseCount >= minimumPurchases && milestoneSpendSyp >= minimumSpendSyp;
  const unlockedSyp = unlocked ? lockedCashbackSyp : 0n;
  const availableCashbackSyp = progress.availableCashbackSyp + unlockedSyp;
  if (verifiedPurchaseCount > MAX_POSTGRES_INT || milestonePurchaseCount > MAX_POSTGRES_INT ||
      milestoneSpendSyp > MAX_MONEY_MINOR_UNITS || lockedCashbackSyp > MAX_MONEY_MINOR_UNITS ||
      availableCashbackSyp > MAX_MONEY_MINOR_UNITS) throw new RangeError('Cashback milestone exceeds a supported range.');

  return { unlockedSyp, update: {
    verifiedPurchaseCount, milestonePurchaseCount: unlocked ? 0 : milestonePurchaseCount,
    milestoneSpendSyp: unlocked ? 0n : milestoneSpendSyp,
    lockedCashbackSyp: unlocked ? 0n : lockedCashbackSyp, availableCashbackSyp,
  } };
}
