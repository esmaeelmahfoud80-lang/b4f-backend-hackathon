import {
  type ArgumentsHost, Catch, Controller, type ExceptionFilter, Header, PayloadTooLargeException, Post,
  UploadedFile, UseFilters, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiCreatedResponse, ApiProperty, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { ActorThrottlerGuard } from '../common/http/actor-throttler.guard';
import { AuthErrorDto } from '../common/http/auth-error.dto';
import { MAX_IMAGE_BYTES, type ImageUpload } from './image-processing.service';
import { mediaError } from './media-errors';
import { MediaService } from './media.service';
import { VerifiedUploadMerchantGuard } from './verified-upload-merchant.guard';

class UploadImageResponseDto {
  @ApiProperty({ format: 'uri', example: 'https://ik.imagekit.io/your-imagekit-id/mardood/products/example.webp' })
  imageUrl!: string;
}

@Catch(PayloadTooLargeException)
class UploadLimitFilter implements ExceptionFilter {
  catch(_exception: PayloadTooLargeException, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<{ status: (code: number) => { json: (body: unknown) => void } }>();
    response.status(413).json(mediaError('IMAGE_TOO_LARGE').getResponse());
  }
}

@ApiTags('Merchant uploads')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, ActorThrottlerGuard, VerifiedUploadMerchantGuard)
@Roles('merchant')
@Controller('merchant/uploads')
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @Post('image')
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UseFilters(UploadLimitFilter)
  @UseInterceptors(FileInterceptor('file', {
    // The parser signals its byte limit on equality. The processor enforces the inclusive cap.
    limits: { fileSize: MAX_IMAGE_BYTES + 1, files: 1, fields: 0, parts: 2 },
  }))
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', required: ['file'], properties: {
    file: { type: 'string', format: 'binary', description: 'One static JPEG, PNG or WebP, at most 500,000 bytes.' },
  } } })
  @ApiCreatedResponse({ type: UploadImageResponseDto })
  @ApiResponse({ status: 400, type: AuthErrorDto, description: 'VALIDATION_ERROR' })
  @ApiResponse({ status: 401, type: AuthErrorDto, description: 'AUTH_REQUIRED or SESSION_EXPIRED' })
  @ApiResponse({ status: 403, type: AuthErrorDto, description: 'FORBIDDEN or MERCHANT_NOT_VERIFIED' })
  @ApiResponse({ status: 413, type: AuthErrorDto, description: 'IMAGE_TOO_LARGE' })
  @ApiResponse({ status: 415, type: AuthErrorDto, description: 'UNSUPPORTED_IMAGE_FORMAT' })
  @ApiResponse({ status: 429, type: AuthErrorDto, description: 'RATE_LIMITED' })
  @ApiResponse({ status: 502, type: AuthErrorDto, description: 'IMAGE_UPLOAD_FAILED' })
  @ApiResponse({ status: 503, type: AuthErrorDto, description: 'IMAGE_UPLOAD_UNAVAILABLE' })
  upload(@UploadedFile() file?: ImageUpload): Promise<UploadImageResponseDto> {
    return this.media.upload(file);
  }
}
