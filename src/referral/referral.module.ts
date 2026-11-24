import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ReferralController } from './referral.controller';
import { ReferralService } from './referral.service';
import { ActorThrottlerGuard } from '../common/http/actor-throttler.guard';

@Module({
  imports: [AuthModule, PrismaModule],
  controllers: [ReferralController],
  providers: [ReferralService, ActorThrottlerGuard],
})
export class ReferralModule {}
