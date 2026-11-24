import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { Equals, IsString, Length, Matches, ValidateIf } from 'class-validator';
import { MAX_MONEY_MINOR_UNITS } from '../common/money';

const money = { type: 'integer', minimum: 0, maximum: Number(MAX_MONEY_MINOR_UNITS),
  description: 'Integer hundredths of one new Syrian Pound (SYP).' } as const;

export class ScannerCodeDto {
  @ApiProperty({ description: 'Offer QR token or human-readable pass code.', maxLength: 128, example: 'OF-DEMO01' })
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value)
  @IsString()
  @Length(1, 128)
  @Matches(/^[A-Za-z0-9_-]+$/)
  code!: string;
}

export class RedeemOfferDto extends ScannerCodeDto {
  @ApiPropertyOptional({ type: 'integer', enum: [1], default: 1 })
  @ValidateIf((input: RedeemOfferDto) => input.quantity !== undefined)
  @Equals(1)
  quantity?: 1;
}

class ScannerQuantityOptionDto {
  @ApiProperty({ type: 'integer', enum: [1] })
  quantity!: 1;
  @ApiProperty(money)
  customerPaidCashSyp!: number;
}

export class ScannerOfferDto {
  @ApiProperty({ enum: ['offer_qr'] })
  kind!: 'offer_qr';
  @ApiProperty({ format: 'uuid' })
  passId!: string;
  @ApiProperty({ format: 'uuid' })
  campaignId!: string;
  @ApiProperty({ enum: ['product'] })
  campaignType!: 'product';
  @ApiProperty()
  productName!: string;
  @ApiProperty()
  customerName!: string;
  @ApiProperty({ minimum: 0, maximum: 100, multipleOf: 0.01 })
  discountPercent!: number;
  @ApiProperty(money)
  finalPriceSyp!: number;
  @ApiProperty({ type: 'integer', enum: [1] })
  maxQuantity!: 1;
  @ApiProperty({ type: [ScannerQuantityOptionDto] })
  availableQuantityOptions!: ScannerQuantityOptionDto[];
  @ApiProperty({ enum: ['active'] })
  status!: 'active';
}

export class OfferRedeemResultDto {
  @ApiProperty({ format: 'uuid' })
  saleId!: string;
  @ApiProperty({ format: 'uuid' })
  campaignId!: string;
  @ApiProperty()
  productName!: string;
  @ApiProperty({ type: 'integer', enum: [1] })
  quantity!: 1;
  @ApiProperty(money)
  originalAmountSyp!: number;
  @ApiProperty(money)
  customerPaidCashSyp!: number;
  @ApiProperty(money)
  marketerCommissionSyp!: number;
  @ApiProperty(money)
  platformTotalFeeSyp!: number;
  @ApiProperty(money)
  customerCashbackSyp!: number;
  @ApiProperty(money)
  platformNetFeeSyp!: number;
  @ApiProperty(money)
  remainingLockedBudgetSyp!: number;
  @ApiProperty({ enum: ['active', 'ended'] })
  campaignStatusAfterSale!: 'active' | 'ended';
  @ApiProperty({ format: 'date-time' })
  scannedAt!: string;
}
