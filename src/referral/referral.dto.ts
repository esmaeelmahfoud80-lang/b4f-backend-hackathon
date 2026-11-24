import { ApiProperty } from '@nestjs/swagger';
import { MAX_MONEY_MINOR_UNITS } from '../common/money';

const money = {
  type: 'integer', minimum: 1, maximum: Number(MAX_MONEY_MINOR_UNITS), nullable: true,
  description: 'Integer hundredths of one new Syrian Pound (SYP).',
} as const;

export class PublicOfferDto {
  @ApiProperty({ format: 'uuid' })
  campaignId!: string;
  @ApiProperty({ enum: ['product', 'store_discount'] })
  campaignType!: 'product' | 'store_discount';
  @ApiProperty()
  shopName!: string;
  @ApiProperty()
  shopDetails!: string;
  @ApiProperty()
  productName!: string;
  @ApiProperty()
  description!: string;
  @ApiProperty({ format: 'uri' })
  imageUrl!: string;
  @ApiProperty(money)
  originalPriceSyp!: number | null;
  @ApiProperty({ minimum: 0, maximum: 100, multipleOf: 0.01 })
  discountPercent!: number;
  @ApiProperty(money)
  finalPriceSyp!: number | null;
  @ApiProperty({ format: 'date-time', description: 'Campaign availability ends at this time or on earlier closure.' })
  endsAt!: string;
  @ApiProperty({ enum: ['active', 'ended'] })
  status!: 'active' | 'ended';
  @ApiProperty()
  attributionLabel!: string;
}

export class OfferQrPassDto {
  @ApiProperty({ format: 'uuid' })
  passId!: string;
  @ApiProperty({ format: 'uuid' })
  campaignId!: string;
  @ApiProperty({ enum: ['product', 'store_discount'] })
  campaignType!: 'product' | 'store_discount';
  @ApiProperty()
  productName!: string;
  @ApiProperty()
  shopName!: string;
  @ApiProperty({ minimum: 0, maximum: 100, multipleOf: 0.01 })
  discountPercent!: number;
  @ApiProperty(money)
  finalPriceSyp!: number | null;
  @ApiProperty({ description: 'Opaque secret to encode as the customer’s Offer QR.' })
  qrToken!: string;
  @ApiProperty({ description: 'Human-readable Offer QR fallback code.' })
  passCode!: string;
  @ApiProperty({ enum: ['active', 'redeemed', 'expired'], description: 'An active pass is usable until redeemed or the campaign ends. Passes have no independent TTL.' })
  status!: 'active' | 'redeemed' | 'expired';
  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}
