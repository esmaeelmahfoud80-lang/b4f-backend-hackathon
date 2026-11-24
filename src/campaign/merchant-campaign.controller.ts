import { Body, Controller, Get, Header, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiExtraModels, ApiHeader, ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentActor, type AuthenticatedActor } from '../auth/authenticated-actor';
import { AuthErrorDto } from '../common/http/auth-error.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { IdempotencyKey } from '../common/idempotency/idempotency-key';
import { CampaignFixedCommissionDto, CampaignPercentageCommissionDto, LaunchCampaignDto, MerchantCampaignDto, MerchantCampaignPageDto, MerchantCampaignQueryDto } from './dto/campaign.dto';
import { CampaignPreviewDto, CampaignPreviewInputDto } from './dto/campaign-preview.dto';
import { CampaignPreviewService } from './campaign-preview.service';
import { CampaignService } from './campaign.service';

@ApiTags('Merchant campaigns')
@ApiBearerAuth()
@ApiExtraModels(CampaignFixedCommissionDto, CampaignPercentageCommissionDto)
@ApiResponse({ status: 400, type: AuthErrorDto, description: 'VALIDATION_ERROR' })
@ApiResponse({ status: 401, type: AuthErrorDto, description: 'AUTH_REQUIRED or SESSION_EXPIRED' })
@ApiResponse({ status: 403, type: AuthErrorDto, description: 'FORBIDDEN' })
@ApiResponse({ status: 500, type: AuthErrorDto, description: 'INTERNAL_ERROR' })
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('merchant')
@Controller('merchant/campaigns')
export class CampaignPreviewController {
  constructor(private readonly previews: CampaignPreviewService, private readonly campaigns: CampaignService) {}

  @Post('preview')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Preview a product campaign', description: 'Read-only. Insufficient funds return 200 with isAffordableByMerchant set to false.' })
  @ApiBody({ type: CampaignPreviewInputDto })
  @ApiOkResponse({ type: CampaignPreviewDto })
  @ApiResponse({ status: 409, type: AuthErrorDto, description: 'AMOUNT_OUT_OF_RANGE' })
  preview(@CurrentActor() actor: AuthenticatedActor, @Body() input: CampaignPreviewInputDto) {
    return this.previews.preview(actor.userId, input);
  }

  @Post()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Launch a verified merchant’s product campaign and lock its reserve' })
  @ApiHeader({ name: 'Idempotency-Key', required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiBody({ type: LaunchCampaignDto })
  @ApiCreatedResponse({ type: MerchantCampaignDto })
  @ApiResponse({ status: 403, type: AuthErrorDto, description: 'FORBIDDEN or MERCHANT_NOT_VERIFIED' })
  @ApiResponse({ status: 409, type: AuthErrorDto, description: 'AMOUNT_OUT_OF_RANGE, INSUFFICIENT_MERCHANT_BALANCE or IDEMPOTENCY_KEY_REUSED' })
  async launch(@CurrentActor() actor: AuthenticatedActor, @IdempotencyKey() key: string, @Body() input: LaunchCampaignDto) {
    const response = await this.campaigns.launch(actor.userId, key, input);
    return response.body;
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'List the authenticated merchant’s campaigns' })
  @ApiOkResponse({ type: MerchantCampaignPageDto })
  @ApiResponse({ status: 409, type: AuthErrorDto, description: 'AMOUNT_OUT_OF_RANGE' })
  list(@CurrentActor() actor: AuthenticatedActor, @Query() query: MerchantCampaignQueryDto) {
    return this.campaigns.list(actor.userId, query);
  }

  @Get(':campaignId')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Get a campaign owned by the authenticated merchant' })
  @ApiOkResponse({ type: MerchantCampaignDto })
  @ApiResponse({ status: 404, type: AuthErrorDto, description: 'NOT_FOUND' })
  @ApiResponse({ status: 409, type: AuthErrorDto, description: 'AMOUNT_OUT_OF_RANGE' })
  detail(@CurrentActor() actor: AuthenticatedActor, @Param('campaignId', ParseUUIDPipe) campaignId: string) {
    return this.campaigns.detail(actor.userId, campaignId);
  }

  @Post(':campaignId/close')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'End an owned campaign and release its remaining reserve once' })
  @ApiOkResponse({ type: MerchantCampaignDto })
  @ApiResponse({ status: 404, type: AuthErrorDto, description: 'NOT_FOUND' })
  @ApiResponse({ status: 409, type: AuthErrorDto, description: 'AMOUNT_OUT_OF_RANGE' })
  close(@CurrentActor() actor: AuthenticatedActor, @Param('campaignId', ParseUUIDPipe) campaignId: string) {
    return this.campaigns.close(actor.userId, campaignId);
  }
}
