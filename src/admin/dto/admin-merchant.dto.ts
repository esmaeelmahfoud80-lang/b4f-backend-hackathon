import { ApiProperty, ApiPropertyOptional, PickType } from '@nestjs/swagger';
import { IsEnum, IsIn, IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';
import { AccountDto, MerchantAccountDto } from '../../auth/dto/auth-session.dto';
import { MAX_MONEY_MINOR_UNITS } from '../../common/money';
import { PageDto, PageQueryDto } from '../../common/pagination.dto';
import { MerchantVerificationStatus } from '../../generated/prisma/client';

const decisions = ['verified', 'rejected'] as const;
const money = { type: 'integer', minimum: 0, maximum: Number(MAX_MONEY_MINOR_UNITS),
  description: 'Integer hundredths of one new Syrian Pound (SYP).' } as const;

export class AdminMerchantQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: MerchantVerificationStatus })
  @IsOptional()
  @IsEnum(MerchantVerificationStatus)
  verificationStatus?: MerchantVerificationStatus;
}

export class VerifyMerchantDto {
  @ApiProperty({ enum: decisions })
  @IsIn(decisions)
  status!: (typeof decisions)[number];

  @ApiPropertyOptional({ maxLength: 256, description: 'Omit to preserve the existing reference.' })
  @ValidateIf((input: VerifyMerchantDto) => input.contractReference !== undefined)
  @IsString()
  @MaxLength(256)
  contractReference?: string;
}

class AdminMerchantWalletDto {
  @ApiProperty(money)
  availableBalanceSyp!: number;

  @ApiProperty({ ...money, description: 'Campaign funds currently locked, in integer hundredths of one new Syrian Pound (SYP).' })
  totalLockedReservesSyp!: number;

  @ApiProperty(money)
  creditLimitSyp!: number;
}

export class AdminMerchantDto extends PickType(AccountDto, ['id', 'name', 'phone', 'roles', 'createdAt'] as const) {
  @ApiProperty({ type: MerchantAccountDto })
  merchant!: MerchantAccountDto;

  @ApiProperty({ type: AdminMerchantWalletDto })
  wallet!: AdminMerchantWalletDto;
}

export class AdminMerchantPageDto extends PageDto {
  @ApiProperty({ type: [AdminMerchantDto] })
  items!: AdminMerchantDto[];
}
