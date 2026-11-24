import { ApiProperty } from '@nestjs/swagger';
import { PageDto } from '../../common/pagination.dto';
import { MerchantVerificationStatus } from '../../generated/prisma/client';
import { conversion, count, money, nullableName } from './reporting-dto-options';

const merchantKinds = ['merchant_topup', 'campaign_reserve_lock', 'campaign_reserve_unlock',
  'sale_reserve_debit', 'cashback_voucher_merchant_credit'] as const;

export class MerchantWalletDto {
  @ApiProperty(money) availableBalanceSyp!: number;
  @ApiProperty(money) totalLockedReservesSyp!: number;
  @ApiProperty(money) creditLimitSyp!: number;
}

export class MerchantWalletTransactionDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: [...merchantKinds] }) kind!: typeof merchantKinds[number];
  @ApiProperty(money) amountSyp!: number;
  @ApiProperty({ ...nullableName, format: 'uuid' }) campaignId!: string | null;
  @ApiProperty(nullableName) campaignName!: string | null;
  @ApiProperty(nullableName) referenceNote!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

export class MerchantWalletTransactionPageDto extends PageDto {
  @ApiProperty({ type: [MerchantWalletTransactionDto] }) items!: MerchantWalletTransactionDto[];
}

class TopMerchantCampaignDto {
  @ApiProperty({ format: 'uuid' }) campaignId!: string;
  @ApiProperty() productName!: string;
  @ApiProperty(money) grossCashSalesSyp!: number;
  @ApiProperty(count) salesCount!: number;
}

class MerchantStatsDto {
  @ApiProperty(count) clicks!: number;
  @ApiProperty(count) salesCount!: number;
  @ApiProperty(count) itemsSold!: number;
  @ApiProperty(money) grossCashSalesSyp!: number;
  @ApiProperty(money) commissionPaidSyp!: number;
  @ApiProperty(money) platformFeesPaidSyp!: number;
  @ApiProperty(conversion) conversionRatePercent!: number;
}

export class MerchantDashboardDto {
  @ApiProperty({ enum: MerchantVerificationStatus }) verificationStatus!: MerchantVerificationStatus;
  @ApiProperty({ type: MerchantWalletDto }) wallet!: MerchantWalletDto;
  @ApiProperty(count) activeCampaignsCount!: number;
  @ApiProperty({ type: TopMerchantCampaignDto, nullable: true }) topCampaign!: TopMerchantCampaignDto | null;
  @ApiProperty({ type: MerchantStatsDto }) stats!: MerchantStatsDto;
}
