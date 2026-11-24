import { BadRequestException, Controller, Get, Header, Param, ParseUUIDPipe, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiExtraModels, ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentActor, type AuthenticatedActor } from '../auth/authenticated-actor';
import { AuthErrorDto } from '../common/http/auth-error.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { CampaignDto, CampaignFixedCommissionDto, CampaignPercentageCommissionDto } from './dto/campaign.dto';
import {
  CampaignDiscoveryQueryDto, DiscoverableCampaignPageDto, MarketerMembershipDto, MarketerMembershipLookupDto,
  MarketerMembershipPageDto, MarketerMembershipQueryDto,
} from './dto/marketer-campaign.dto';
import { MarketerCampaignService } from './marketer-campaign.service';

@ApiTags('Marketer campaigns')
@ApiBearerAuth()
@ApiExtraModels(CampaignFixedCommissionDto, CampaignPercentageCommissionDto)
@ApiResponse({ status: 400, type: AuthErrorDto, description: 'VALIDATION_ERROR' })
@ApiResponse({ status: 401, type: AuthErrorDto, description: 'AUTH_REQUIRED or SESSION_EXPIRED' })
@ApiResponse({ status: 403, type: AuthErrorDto, description: 'FORBIDDEN' })
@ApiResponse({ status: 409, type: AuthErrorDto, description: 'AMOUNT_OUT_OF_RANGE' })
@ApiResponse({ status: 500, type: AuthErrorDto, description: 'INTERNAL_ERROR' })
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('marketer')
@Controller()
export class MarketerCampaignController {
  constructor(private readonly campaigns: MarketerCampaignService) {}

  @Get('campaigns')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Discover active campaigns available in the demo' })
  @ApiOkResponse({ type: DiscoverableCampaignPageDto })
  list(@Query() query: CampaignDiscoveryQueryDto) {
    return this.campaigns.discover(query);
  }

  @Get('campaigns/:campaignId')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Read a discoverable campaign' })
  @ApiOkResponse({ type: CampaignDto })
  @ApiResponse({ status: 404, type: AuthErrorDto, description: 'NOT_FOUND' })
  detail(@Param('campaignId', ParseUUIDPipe) campaignId: string) {
    return this.campaigns.detail(campaignId);
  }

  @Post('marketer/campaigns/:campaignId/join')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Join an open campaign', description: 'Send an empty request body. An approved membership includes its referral URL.' })
  @ApiCreatedResponse({ type: MarketerMembershipDto, description: 'New approved membership' })
  @ApiOkResponse({ type: MarketerMembershipDto, description: 'Existing approved or resubmitted membership' })
  @ApiResponse({ status: 403, type: AuthErrorDto, description: 'FORBIDDEN or SELF_PROMOTION_FORBIDDEN' })
  @ApiResponse({ status: 404, type: AuthErrorDto, description: 'NOT_FOUND' })
  @ApiResponse({ status: 409, type: AuthErrorDto, description: 'CAMPAIGN_ENDED, JOIN_REQUEST_PENDING or AMOUNT_OUT_OF_RANGE' })
  async join(
    @CurrentActor() actor: AuthenticatedActor, @Param('campaignId', ParseUUIDPipe) campaignId: string,
    @Req() request: { body?: unknown }, @Res() response: { status(code: number): { json(body: MarketerMembershipDto): unknown } },
  ) {
    const input = request.body;
    if (input !== undefined && (input === null || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 0)) {
      throw new BadRequestException('Joining does not accept request fields.');
    }
    const result = await this.campaigns.join(actor.userId, campaignId);
    response.status(result.statusCode).json(result.body);
  }

  @Get('marketer/campaigns/:campaignId/membership')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Read the signed-in marketer’s membership for a campaign' })
  @ApiOkResponse({ type: MarketerMembershipLookupDto })
  membership(@CurrentActor() actor: AuthenticatedActor, @Param('campaignId', ParseUUIDPipe) campaignId: string) {
    return this.campaigns.membership(actor.userId, campaignId);
  }

  @Get('marketer/memberships')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'List the signed-in marketer’s memberships' })
  @ApiOkResponse({ type: MarketerMembershipPageDto })
  memberships(@CurrentActor() actor: AuthenticatedActor, @Query() query: MarketerMembershipQueryDto) {
    return this.campaigns.memberships(actor.userId, query);
  }
}
