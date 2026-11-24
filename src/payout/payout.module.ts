import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { IdempotencyModule } from '../common/idempotency/idempotency.module';
import { PrismaModule } from '../prisma/prisma.module';
import { AdminPayoutController, MarketerPayoutController } from './payout.controller';
import { PayoutService } from './payout.service';

@Module({
  imports: [AuthModule, IdempotencyModule, PrismaModule],
  controllers: [MarketerPayoutController, AdminPayoutController],
  providers: [PayoutService],
})
export class PayoutModule {}
