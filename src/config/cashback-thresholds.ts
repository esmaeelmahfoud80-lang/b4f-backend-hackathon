import type { ConfigService } from '@nestjs/config';
import { MAX_MONEY_MINOR_UNITS } from '../common/money';
import { MAX_POSTGRES_INT } from '../common/postgres-limits';
import { ApiConfigurationError } from '../prisma/database-config';

export function parseCashbackThresholds(purchaseSetting: unknown, spendSetting: unknown) {
  const purchases = purchaseSetting ?? '5';
  const spend = spendSetting ?? '50000';

  if (typeof purchases !== 'string' || !/^[1-9][0-9]{0,9}$/.test(purchases) || Number(purchases) > MAX_POSTGRES_INT) {
    throw new ApiConfigurationError('CASHBACK_MILESTONE_PURCHASES must be a positive integer within the supported range.');
  }
  if (typeof spend !== 'string' || !/^[1-9][0-9]{0,15}$/.test(spend) || BigInt(spend) > MAX_MONEY_MINOR_UNITS) {
    throw new ApiConfigurationError('CASHBACK_MILESTONE_SPEND_SYP must be a positive integer in new SYP minor units within the supported range.');
  }

  const minimumPurchases = Number(purchases);
  const minimumSpendSyp = BigInt(spend);
  return { minimumPurchases, minimumSpendSyp };
}

export function cashbackThresholds(config: ConfigService) {
  return parseCashbackThresholds(
    config.get<string>('CASHBACK_MILESTONE_PURCHASES'),
    config.get<string>('CASHBACK_MILESTONE_SPEND_SYP'),
  );
}
