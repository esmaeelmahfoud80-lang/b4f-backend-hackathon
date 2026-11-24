import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ActorThrottlerGuard } from '../common/http/actor-throttler.guard';
import { ImageProcessingService } from './image-processing.service';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';
import { VerifiedUploadMerchantGuard } from './verified-upload-merchant.guard';

@Module({
  imports: [AuthModule],
  controllers: [MediaController],
  providers: [ActorThrottlerGuard, VerifiedUploadMerchantGuard, ImageProcessingService, MediaService],
})
export class MediaModule {}
