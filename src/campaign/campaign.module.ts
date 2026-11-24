import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { IdempotencyModule } from '../common/idempotency/idempotency.module';
import { PrismaModule } from '../prisma/prisma.module';
import { CampaignPreviewController } from './merchant-campaign.controller';
import { CampaignPreviewService } from './campaign-preview.service';
import { CampaignService } from './campaign.service';
import { MarketerCampaignController } from './marketer-campaign.controller';
import { MarketerCampaignService } from './marketer-campaign.service';

@Module({
  imports: [AuthModule, PrismaModule, IdempotencyModule],
  controllers: [CampaignPreviewController, MarketerCampaignController],
  providers: [CampaignPreviewService, CampaignService, MarketerCampaignService],
  exports: [CampaignService],
})
export class CampaignModule {}
