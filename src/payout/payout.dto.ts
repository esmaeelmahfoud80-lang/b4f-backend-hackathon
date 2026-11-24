import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEnum, IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { MAX_MONEY_MINOR_UNITS } from '../common/money';
import { PageDto, PageQueryDto } from '../common/pagination.dto';
import { PayoutStatus } from '../generated/prisma/client';

const amount = { type: 'integer', minimum: 1, maximum: Number(MAX_MONEY_MINOR_UNITS),
  description: 'Integer hundredths of one new Syrian Pound (SYP).' } as const;

export class CreatePayoutDto {
  @ApiProperty({ ...amount, example: 50000 })
  @IsInt()
  @Min(1)
  @Max(Number(MAX_MONEY_MINOR_UNITS))
  expectedAmountSyp!: number;
}

export class RejectPayoutDto {
  @ApiProperty({ minLength: 1, maxLength: 500 })
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value)
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}

export class PayoutPageQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: PayoutStatus })
  @IsOptional()
  @IsEnum(PayoutStatus)
  status?: PayoutStatus;
}

export class PayoutDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty(amount) amountSyp!: number;
  @ApiProperty({ enum: PayoutStatus }) status!: PayoutStatus;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) decidedAt!: string | null;
  @ApiProperty({ type: String, maxLength: 500, nullable: true }) rejectionReason!: string | null;
}

export class AdminPayoutDto extends PayoutDto {
  @ApiProperty({ format: 'uuid' }) marketerId!: string;
  @ApiProperty() marketerName!: string;
}

export class PayoutPageDto extends PageDto {
  @ApiProperty({ type: [PayoutDto] }) items!: PayoutDto[];
}

export class AdminPayoutPageDto extends PageDto {
  @ApiProperty({ type: [AdminPayoutDto] }) items!: AdminPayoutDto[];
}
