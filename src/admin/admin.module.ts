import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { IdempotencyModule } from '../common/idempotency/idempotency.module';
import { PrismaModule } from '../prisma/prisma.module';
import { AdminMerchantController } from './admin-merchant.controller';
import { AdminMerchantService } from './admin-merchant.service';
import { AdminRevenueController } from './admin-revenue.controller';
import { AdminRevenueService } from './admin-revenue.service';
import { AdminTopupController } from './admin-topup.controller';
import { AdminTopupService } from './admin-topup.service';

@Module({
  imports: [AuthModule, PrismaModule, IdempotencyModule],
  controllers: [AdminMerchantController, AdminTopupController, AdminRevenueController],
  providers: [AdminMerchantService, AdminTopupService, AdminRevenueService],
})
export class AdminMerchantModule {}
