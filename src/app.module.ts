import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AdminMerchantModule } from './admin/admin.module';
import { AuthModule } from './auth/auth.module';
import { CampaignModule } from './campaign/campaign.module';
import { validateApiConfig } from './config/api-config';
import { HealthModule } from './health/health.module';
import { MediaModule } from './media/media.module';
import { PayoutModule } from './payout/payout.module';
import { PrismaModule } from './prisma/prisma.module';
import { ReferralModule } from './referral/referral.module';
import { ReportingModule } from './reporting/reporting.module';
import { ScannerModule } from './scanner/scanner.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateApiConfig }),
    HealthModule,
    PrismaModule,
    AuthModule,
    CampaignModule,
    ReferralModule,
    ScannerModule,
    AdminMerchantModule,
    ReportingModule,
    MediaModule,
    PayoutModule,
  ],
})
export class AppModule {}
