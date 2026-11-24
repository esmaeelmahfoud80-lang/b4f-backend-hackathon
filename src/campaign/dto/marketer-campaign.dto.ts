import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { MAX_MONEY_MINOR_UNITS } from '../../common/money';
import { CampaignDto, CampaignPageDto, CampaignPageQueryDto } from './campaign.dto';

const campaignTypes = ['product', 'store_discount'] as const;
const joinModes = ['open', 'approval_required'] as const;
const membershipStatuses = ['pending', 'approved', 'rejected'] as const;

export class CampaignDiscoveryQueryDto extends CampaignPageQueryDto {
  @ApiPropertyOptional({ maxLength: 100, description: 'Case-insensitive search by product or shop name.' })
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value)
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({ enum: joinModes, description: 'The demo publishes open campaigns.' })
  @IsOptional()
  @IsIn(joinModes)
  joinMode?: (typeof joinModes)[number];

  @ApiPropertyOptional({ enum: campaignTypes, description: 'The demo publishes product campaigns.' })
  @IsOptional()
  @IsIn(campaignTypes)
  campaignType?: (typeof campaignTypes)[number];
}

export class MarketerMembershipQueryDto extends CampaignPageQueryDto {
  @ApiPropertyOptional({ enum: membershipStatuses })
  @IsOptional()
  @IsIn(membershipStatuses)
  status?: (typeof membershipStatuses)[number];
}

export class DiscoverableCampaignPageDto extends CampaignPageDto {
  @ApiProperty({ type: [CampaignDto] })
  items!: CampaignDto[];
}

class MarketerCampaignStatsDto {
  @ApiProperty({ type: 'integer', minimum: 0 })
  clicks!: number;

  @ApiProperty({ type: 'integer', minimum: 0 })
  itemsSold!: number;

  @ApiProperty({ type: 'integer', minimum: 0, maximum: Number(MAX_MONEY_MINOR_UNITS),
    description: 'Commission earned in integer hundredths of one new Syrian Pound (SYP).' })
  earnedSyp!: number;

  @ApiProperty({ minimum: 0, multipleOf: 0.01 })
  conversionRatePercent!: number;
}

export class MarketerMembershipDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: membershipStatuses })
  status!: (typeof membershipStatuses)[number];

  @ApiProperty({ format: 'date-time' })
  requestedAt!: string;

  @ApiProperty({ type: CampaignDto })
  campaign!: CampaignDto;

  @ApiProperty({ type: String, format: 'uri', nullable: true })
  referralUrl!: string | null;

  @ApiProperty({ type: MarketerCampaignStatsDto })
  stats!: MarketerCampaignStatsDto;
}

export class MarketerMembershipLookupDto {
  @ApiProperty({ type: MarketerMembershipDto, nullable: true })
  membership!: MarketerMembershipDto | null;
}

export class MarketerMembershipPageDto extends CampaignPageDto {
  @ApiProperty({ type: [MarketerMembershipDto] })
  items!: MarketerMembershipDto[];
}
