import { MAX_MONEY_MINOR_UNITS } from '../../common/money';

export const money = { type: 'integer', minimum: 0, maximum: Number(MAX_MONEY_MINOR_UNITS),
  description: 'Integer hundredths of one new Syrian Pound (SYP).' } as const;
export const count = { type: 'integer', minimum: 0 } as const;
export const nullableName = { type: String, nullable: true } as const;
export const conversion = { type: Number, minimum: 0, description: 'Items sold divided by clicks, times 100, rounded to two decimals. Zero when there are no clicks.' } as const;
