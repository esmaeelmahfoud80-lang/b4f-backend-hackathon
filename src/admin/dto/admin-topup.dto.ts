import { ApiProperty, ApiPropertyOptional, OmitType } from '@nestjs/swagger';
import { IsEnum, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';
import { MAX_MONEY_MINOR_UNITS } from '../../common/money';
import { PageDto, PageQueryDto } from '../../common/pagination.dto';
import { TopupPaymentMethod } from '../../generated/prisma/client';

const money = { type: 'integer', minimum: 0, maximum: Number(MAX_MONEY_MINOR_UNITS),
  description: 'Integer hundredths of one new Syrian Pound (SYP).' } as const;

export class CreateAdminTopupDto {
  @ApiProperty({ ...money, minimum: 1 })
  @IsInt()
  @Min(1)
  @Max(Number(MAX_MONEY_MINOR_UNITS))
  amountSyp!: number;

  @ApiProperty({ enum: TopupPaymentMethod })
  @IsEnum(TopupPaymentMethod)
  paymentMethod!: TopupPaymentMethod;

  @ApiProperty({ minLength: 1, maxLength: 256, description: 'Nonblank reference for the confirmed offline payment.' })
  @IsString()
  @Matches(/\S/u)
  @MaxLength(256)
  referenceNote!: string;
}

export class AdminTopupQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  merchantId?: string;
}

export class AdminTopupResultDto {
  @ApiProperty({ format: 'uuid' })
  topupId!: string;

  @ApiProperty({ format: 'uuid' })
  merchantId!: string;

  @ApiProperty()
  shopName!: string;

  @ApiProperty({ ...money, minimum: 1 })
  amountSyp!: number;

  @ApiProperty({ enum: TopupPaymentMethod })
  paymentMethod!: TopupPaymentMethod;

  @ApiProperty()
  referenceNote!: string;

  @ApiProperty({ ...money, description: 'Wallet balance immediately after this credit, in integer hundredths of one new Syrian Pound (SYP).' })
  merchantNewAvailableBalanceSyp!: number;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

export class AdminTopupHistoryEntryDto extends OmitType(AdminTopupResultDto, ['merchantNewAvailableBalanceSyp'] as const) {
  @ApiProperty({ ...money, nullable: true,
    description: 'Stored post-credit balance in integer hundredths of one new Syrian Pound (SYP). Null for legacy top-ups without a verified snapshot.' })
  merchantNewAvailableBalanceSyp!: number | null;
}

export class AdminTopupPageDto extends PageDto {
  @ApiProperty({ type: [AdminTopupHistoryEntryDto] })
  items!: AdminTopupHistoryEntryDto[];
}
