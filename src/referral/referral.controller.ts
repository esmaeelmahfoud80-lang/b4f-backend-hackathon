import { BadRequestException, Controller, Get, Header, HttpCode, HttpStatus, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiNoContentResponse, ApiOkResponse, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentActor, type AuthenticatedActor } from '../auth/authenticated-actor';
import { AuthErrorDto } from '../common/http/auth-error.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { OfferQrPassDto, PublicOfferDto } from './referral.dto';
import { ReferralService } from './referral.service';
import { ActorThrottlerGuard } from '../common/http/actor-throttler.guard';

function requireEmptyBody(request: { body?: unknown }) {
  const { body } = request;
  if (body !== undefined && (body === null || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 0)) {
    throw new BadRequestException('This operation does not accept request fields.');
  }
}

@ApiTags('Referrals and Offer QR')
@ApiParam({ name: 'code', required: true, schema: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}$' } })
@ApiResponse({ status: 404, type: AuthErrorDto, description: 'NOT_FOUND' })
@ApiResponse({ status: 500, type: AuthErrorDto, description: 'INTERNAL_ERROR' })
@Controller()
export class ReferralController {
  constructor(private readonly referrals: ReferralService) {}

  @Get('public/referrals/:code')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Resolve an active public offer without recording a click' })
  @ApiOkResponse({ type: PublicOfferDto })
  @ApiResponse({ status: 409, type: AuthErrorDto, description: 'AMOUNT_OUT_OF_RANGE' })
  offer(@Param('code') code: string) {
    return this.referrals.offer(code);
  }

  @Post('public/referrals/:code/clicks')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(ActorThrottlerGuard)
  @Throttle({ default: { limit: 120, ttl: 60000 } })
  @ApiOperation({ summary: 'Record one referral click', description: 'Send one empty POST per real navigation. Skip SSR and prefetch.' })
  @ApiNoContentResponse({ description: 'Click recorded' })
  @ApiResponse({ status: 400, type: AuthErrorDto, description: 'VALIDATION_ERROR' })
  @ApiResponse({ status: 409, type: AuthErrorDto, description: 'CAMPAIGN_ENDED' })
  @ApiResponse({ status: 429, type: AuthErrorDto, description: 'RATE_LIMITED' })
  click(@Param('code') code: string, @Req() request: { body?: unknown }) {
    requireEmptyBody(request);
    return this.referrals.click(code);
  }

  @Post('customer/referrals/:code/offer-qr')
  @Header('Cache-Control', 'no-store')
  @UseGuards(JwtAuthGuard, RolesGuard, ActorThrottlerGuard)
  @Roles('customer')
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Issue or reuse the signed-in customer’s Offer QR', description: 'Send an empty POST. The pass expires when the campaign ends or closes earlier.' })
  @ApiOkResponse({ type: OfferQrPassDto, description: 'Existing active pass' })
  @ApiCreatedResponse({ type: OfferQrPassDto, description: 'New active pass' })
  @ApiResponse({ status: 400, type: AuthErrorDto, description: 'VALIDATION_ERROR' })
  @ApiResponse({ status: 401, type: AuthErrorDto, description: 'AUTH_REQUIRED or SESSION_EXPIRED' })
  @ApiResponse({ status: 403, type: AuthErrorDto, description: 'FORBIDDEN or SELF_PROMOTION_FORBIDDEN' })
  @ApiResponse({ status: 409, type: AuthErrorDto, description: 'CAMPAIGN_ENDED or AMOUNT_OUT_OF_RANGE' })
  @ApiResponse({ status: 429, type: AuthErrorDto, description: 'RATE_LIMITED' })
  async issue(
    @Param('code') code: string, @CurrentActor() actor: AuthenticatedActor,
    @Req() request: { body?: unknown }, @Res() response: { status(code: number): { json(body: OfferQrPassDto): unknown } },
  ) {
    requireEmptyBody(request);
    const result = await this.referrals.issue(code, actor.userId);
    response.status(result.statusCode).json(result.body);
  }
}
