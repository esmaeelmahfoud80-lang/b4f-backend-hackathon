import { Body, Controller, Header, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiHeader, ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentActor, type AuthenticatedActor } from '../auth/authenticated-actor';
import { AuthErrorDto } from '../common/http/auth-error.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { IdempotencyKey } from '../common/idempotency/idempotency-key';
import { ActorThrottlerGuard } from '../common/http/actor-throttler.guard';
import { OfferRedeemResultDto, RedeemOfferDto, ScannerCodeDto, ScannerOfferDto } from './scanner.dto';
import { ScannerService } from './scanner.service';

@ApiTags('Merchant scanner')
@ApiBearerAuth()
@ApiResponse({ status: 400, type: AuthErrorDto, description: 'VALIDATION_ERROR' })
@ApiResponse({ status: 401, type: AuthErrorDto, description: 'AUTH_REQUIRED or SESSION_EXPIRED' })
@ApiResponse({ status: 403, type: AuthErrorDto, description: 'FORBIDDEN or MERCHANT_NOT_VERIFIED' })
@ApiResponse({ status: 404, type: AuthErrorDto, description: 'NOT_FOUND' })
@ApiResponse({ status: 500, type: AuthErrorDto, description: 'INTERNAL_ERROR' })
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('merchant')
@Controller('merchant/scanner')
export class ScannerController {
  constructor(private readonly scanner: ScannerService) {}

  @Post('lookup')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @UseGuards(ActorThrottlerGuard)
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @ApiOperation({ summary: 'Look up an owned product Offer QR before collecting cash' })
  @ApiOkResponse({ type: ScannerOfferDto })
  @ApiResponse({ status: 409, type: AuthErrorDto, description: 'QR_ALREADY_REDEEMED, QR_EXPIRED, CAMPAIGN_ENDED, CAMPAIGN_LIMIT_EXCEEDED, INSUFFICIENT_LOCKED_BUDGET or AMOUNT_OUT_OF_RANGE' })
  @ApiResponse({ status: 429, type: AuthErrorDto, description: 'RATE_LIMITED' })
  lookup(@CurrentActor() actor: AuthenticatedActor, @Body() input: ScannerCodeDto) {
    return this.scanner.lookup(actor.userId, input.code);
  }

  @Post('redeem-offer')
  @HttpCode(HttpStatus.CREATED)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Confirm cash collection and redeem one product Offer QR', description: 'Submit only after the customer has paid the merchant in cash. Omit quantity or send 1.' })
  @ApiHeader({ name: 'Idempotency-Key', required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiCreatedResponse({ type: OfferRedeemResultDto })
  @ApiResponse({ status: 403, type: AuthErrorDto, description: 'FORBIDDEN, MERCHANT_NOT_VERIFIED or SELF_PROMOTION_FORBIDDEN' })
  @ApiResponse({ status: 409, type: AuthErrorDto, description: 'IDEMPOTENCY_KEY_REUSED, QR_ALREADY_REDEEMED, QR_EXPIRED, CAMPAIGN_ENDED, CAMPAIGN_LIMIT_EXCEEDED, INSUFFICIENT_LOCKED_BUDGET or AMOUNT_OUT_OF_RANGE' })
  async redeem(@CurrentActor() actor: AuthenticatedActor, @IdempotencyKey() key: string, @Body() input: RedeemOfferDto) {
    const response = await this.scanner.redeem(actor.userId, key, input.code);
    return response.body;
  }
}
