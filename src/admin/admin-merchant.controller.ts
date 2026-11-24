import { Body, Controller, Get, Header, Param, ParseUUIDPipe, Patch, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AuthErrorDto } from '../common/http/auth-error.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { AdminMerchantDto, AdminMerchantPageDto, AdminMerchantQueryDto, VerifyMerchantDto } from './dto/admin-merchant.dto';
import { AdminMerchantService } from './admin-merchant.service';

@ApiTags('Admin merchants')
@ApiBearerAuth()
@ApiResponse({ status: 400, type: AuthErrorDto, description: 'VALIDATION_ERROR' })
@ApiResponse({ status: 401, type: AuthErrorDto, description: 'AUTH_REQUIRED or SESSION_EXPIRED' })
@ApiResponse({ status: 403, type: AuthErrorDto, description: 'FORBIDDEN' })
@ApiResponse({ status: 500, type: AuthErrorDto, description: 'INTERNAL_ERROR' })
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
@Controller('admin/merchants')
export class AdminMerchantController {
  constructor(private readonly merchants: AdminMerchantService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'List merchant accounts and merchant wallet balances' })
  @ApiOkResponse({ type: AdminMerchantPageDto })
  @ApiResponse({ status: 409, type: AuthErrorDto, description: 'AMOUNT_OUT_OF_RANGE' })
  list(@Query() query: AdminMerchantQueryDto) {
    return this.merchants.list(query);
  }

  @Patch(':merchantId/verification')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Decide merchant verification', description: 'Decide a pending profile or repeat the existing decision.' })
  @ApiOkResponse({ type: AdminMerchantDto })
  @ApiResponse({ status: 404, type: AuthErrorDto, description: 'NOT_FOUND' })
  @ApiResponse({ status: 409, type: AuthErrorDto, description: 'INVALID_STATUS_TRANSITION or AMOUNT_OUT_OF_RANGE' })
  verify(@Param('merchantId', ParseUUIDPipe) merchantId: string, @Body() input: VerifyMerchantDto) {
    return this.merchants.verify(merchantId, input);
  }
}
