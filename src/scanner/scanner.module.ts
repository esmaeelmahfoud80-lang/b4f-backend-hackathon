import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CampaignModule } from '../campaign/campaign.module';
import { IdempotencyModule } from '../common/idempotency/idempotency.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ActorThrottlerGuard } from '../common/http/actor-throttler.guard';
import { ScannerController } from './scanner.controller';
import { ScannerService } from './scanner.service';

@Module({
  imports: [AuthModule, PrismaModule, IdempotencyModule, CampaignModule],
  controllers: [ScannerController],
  providers: [ScannerService, ActorThrottlerGuard],
})
export class ScannerModule {}
