import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDefined, IsIn, IsInt, IsNumber, IsObject, Max, Min, ValidateNested } from 'class-validator';
import { MAX_MONEY_MINOR_UNITS } from '../../common/money';
import { MAX_CAMPAIGN_ITEMS } from '../campaign-pricing';

const maxMoney = Number(MAX_MONEY_MINOR_UNITS);
const minorUnits = 'Integer hundredths of one new Syrian Pound (SYP).';
const money = { type: 'integer', minimum: 0, maximum: maxMoney, description: minorUnits } as const;

class FixedCommissionDto {
  @ApiProperty({ enum: ['fixed'] })
  @IsIn(['fixed'])
  type!: 'fixed';

  @ApiProperty({ ...money, example: 10000 })
  @IsInt()
  @Min(0)
  @Max(maxMoney)
  amountSyp!: number;
}

export class CampaignPreviewInputDto {
  @ApiProperty({ enum: ['product'] })
  @IsIn(['product'])
  campaignType!: 'product';

  @ApiProperty({ ...money, minimum: 1, example: 100000 })
  @IsInt()
  @Min(1)
  @Max(maxMoney)
  originalPriceSyp!: number;

  @ApiProperty({ minimum: 0, maximum: 100, multipleOf: 0.01, example: 10 })
  @IsNumber()
  @Min(0)
  @Max(100)
  discountPercent!: number;

  @ApiProperty({ type: FixedCommissionDto })
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => FixedCommissionDto)
  commission!: FixedCommissionDto;

  @ApiProperty({ type: 'integer', minimum: 1, maximum: MAX_CAMPAIGN_ITEMS, example: 30 })
  @IsInt()
  @Min(1)
  @Max(MAX_CAMPAIGN_ITEMS)
  maxItems!: number;
}

export class CampaignPreviewDto {
  @ApiProperty({ ...money, minimum: 1, nullable: true, example: 90000 })
  finalPriceSyp!: number | null;

  @ApiProperty({ ...money, example: 90000 })
  sampleSaleAmountSyp!: number;

  @ApiProperty({ ...money, example: 10000 })
  commissionPerUnitSyp!: number;

  @ApiProperty({ ...money, example: 4500 })
  platformTotalFeeSampleSyp!: number;

  @ApiProperty({ ...money, example: 1800 })
  customerCashbackSampleSyp!: number;

  @ApiProperty({ ...money, example: 2700 })
  platformNetFeeSampleSyp!: number;

  @ApiProperty({ ...money, example: 75500 })
  merchantNetSampleSyp!: number;

  @ApiProperty({ ...money, example: 435000 })
  worstCaseReserveSyp!: number;

  @ApiProperty({ description: 'Whether the current available balance covers the reserve.' })
  isAffordableByMerchant!: boolean;

  @ApiProperty({ ...money, example: 100000 })
  merchantAvailableBalanceSyp!: number;
}
