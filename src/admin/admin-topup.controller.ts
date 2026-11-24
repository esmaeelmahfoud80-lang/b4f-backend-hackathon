import { Body, Controller, Get, Header, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiHeader, ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentActor, type AuthenticatedActor } from '../auth/authenticated-actor';
import { AuthErrorDto } from '../common/http/auth-error.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { IdempotencyKey } from '../common/idempotency/idempotency-key';
import { AdminTopupPageDto, AdminTopupQueryDto, AdminTopupResultDto, CreateAdminTopupDto } from './dto/admin-topup.dto';
import { AdminTopupService } from './admin-topup.service';

@ApiTags('Admin top-ups')
@ApiBearerAuth()
@ApiResponse({ status: 400, type: AuthErrorDto, description: 'VALIDATION_ERROR' })
@ApiResponse({ status: 401, type: AuthErrorDto, description: 'AUTH_REQUIRED or SESSION_EXPIRED' })
@ApiResponse({ status: 403, type: AuthErrorDto, description: 'FORBIDDEN' })
@ApiResponse({ status: 500, type: AuthErrorDto, description: 'INTERNAL_ERROR' })
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
@Controller('admin')
export class AdminTopupController {
  constructor(private readonly topups: AdminTopupService) {}

  @Post('merchants/:merchantId/topups')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Record a confirmed offline payment and credit a verified merchant' })
  @ApiHeader({ name: 'Idempotency-Key', required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiBody({ type: CreateAdminTopupDto })
  @ApiCreatedResponse({ type: AdminTopupResultDto })
  @ApiResponse({ status: 403, type: AuthErrorDto, description: 'FORBIDDEN or MERCHANT_NOT_VERIFIED' })
  @ApiResponse({ status: 404, type: AuthErrorDto, description: 'NOT_FOUND' })
  @ApiResponse({ status: 409, type: AuthErrorDto, description: 'AMOUNT_OUT_OF_RANGE or IDEMPOTENCY_KEY_REUSED' })
  async create(
    @CurrentActor() actor: AuthenticatedActor,
    @Param('merchantId', ParseUUIDPipe) merchantId: string,
    @IdempotencyKey() key: string,
    @Body() input: CreateAdminTopupDto,
  ) {
    const result = await this.topups.create(actor.userId, merchantId, key, input);
    return result.body;
  }

  @Get('topups')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'List merchant top-up history, newest first' })
  @ApiOkResponse({ type: AdminTopupPageDto })
  list(@Query() query: AdminTopupQueryDto) {
    return this.topups.list(query);
  }
}
