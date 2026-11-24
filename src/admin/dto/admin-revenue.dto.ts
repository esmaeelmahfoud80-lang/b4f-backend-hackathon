import { ApiProperty } from '@nestjs/swagger';
import { MAX_MONEY_MINOR_UNITS } from '../../common/money';
import { PageDto } from '../../common/pagination.dto';

export class AdminRevenueDto {
  @ApiProperty({
    type: 'integer', minimum: 0, maximum: Number(MAX_MONEY_MINOR_UNITS),
    description: 'All-time net platform fees from settled sales in integer hundredths of one new Syrian Pound (SYP).',
  })
  netPlatformFeesSyp!: number;
}

export class AdminRevenueSummaryDto extends AdminRevenueDto {
  @ApiProperty({
    type: 'integer', minimum: 0, maximum: Number(MAX_MONEY_MINOR_UNITS),
    description: 'All-time commission earned by marketers on settled sales in new SYP minor units.',
  })
  totalMarketerCommissionSyp!: number;
}

export class AdminMarketerEarningsDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  phone!: string;

  @ApiProperty({ type: 'integer', minimum: 0 })
  salesCount!: number;

  @ApiProperty({
    type: 'integer', minimum: 0, maximum: Number(MAX_MONEY_MINOR_UNITS),
    description: 'All-time commission earned from settled sales in new SYP minor units.',
  })
  totalEarnedSyp!: number;
}

export class AdminMarketerEarningsPageDto extends PageDto {
  @ApiProperty({ type: [AdminMarketerEarningsDto] })
  items!: AdminMarketerEarningsDto[];
}
