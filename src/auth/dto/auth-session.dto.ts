import { ApiProperty } from '@nestjs/swagger';
import { MAX_MONEY_MINOR_UNITS } from '../../common/money';

export const ACCESS_TOKEN_SECONDS = 30 * 60;
const roles = ['admin', 'customer', 'marketer', 'merchant'] as const;
const verificationStatuses = ['pending', 'verified', 'rejected'] as const;
export type Role = (typeof roles)[number];

export class MerchantAccountDto {
  @ApiProperty()
  name!: string;

  @ApiProperty()
  details!: string;

  @ApiProperty({ enum: verificationStatuses })
  verificationStatus!: (typeof verificationStatuses)[number];

  @ApiProperty({ type: String, nullable: true })
  contractReference!: string | null;
}

export class CustomerAccountDto {
  @ApiProperty({ type: 'integer', minimum: 0 })
  verifiedPurchaseCount!: number;

  @ApiProperty({ type: 'integer', minimum: 0, maximum: Number(MAX_MONEY_MINOR_UNITS),
    description: 'Available cashback in integer hundredths of one new Syrian Pound (SYP).', example: 100000 })
  availableCashbackSyp!: number;

  @ApiProperty({ type: 'integer', minimum: 0, maximum: Number(MAX_MONEY_MINOR_UNITS),
    description: 'Locked cashback in integer hundredths of one new Syrian Pound (SYP).', example: 1800 })
  lockedCashbackSyp!: number;
}

export class AccountDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ pattern: '^09[0-9]{8}$' })
  phone!: string;

  @ApiProperty({ enum: roles, isArray: true })
  roles!: Role[];

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ type: MerchantAccountDto, nullable: true })
  merchant!: MerchantAccountDto | null;

  @ApiProperty({ type: CustomerAccountDto, nullable: true })
  customer!: CustomerAccountDto | null;
}

export class AuthSessionDto {
  @ApiProperty()
  accessToken!: string;

  @ApiProperty({ type: 'integer', enum: [ACCESS_TOKEN_SECONDS] })
  expiresInSeconds!: number;

  @ApiProperty()
  refreshToken!: string;

  @ApiProperty({ type: AccountDto })
  user!: AccountDto;
}
