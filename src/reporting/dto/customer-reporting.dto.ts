import { ApiProperty } from '@nestjs/swagger';
import { PageDto } from '../../common/pagination.dto';
import { count, money } from './reporting-dto-options';

export class CustomerDashboardDto {
  @ApiProperty(count) verifiedPurchaseCount!: number;
  @ApiProperty(count) milestonePurchaseCount!: number;
  @ApiProperty(count) milestonePurchasesRequired!: number;
  @ApiProperty(money) milestoneSpendSyp!: number;
  @ApiProperty(money) milestoneSpendRequiredSyp!: number;
  @ApiProperty(money) lockedCashbackSyp!: number;
  @ApiProperty(money) availableCashbackSyp!: number;
  @ApiProperty(money) totalCashbackUnlockedSyp!: number;
}

export class CustomerPurchaseDto {
  @ApiProperty({ format: 'uuid' }) saleId!: string;
  @ApiProperty() shopName!: string;
  @ApiProperty() productName!: string;
  @ApiProperty(count) quantity!: number;
  @ApiProperty(money) customerPaidCashSyp!: number;
  @ApiProperty(money) cashbackEarnedSyp!: number;
  @ApiProperty({ format: 'date-time' }) scannedAt!: string;
}

export class CustomerPurchasePageDto extends PageDto {
  @ApiProperty({ type: [CustomerPurchaseDto] }) items!: CustomerPurchaseDto[];
}
