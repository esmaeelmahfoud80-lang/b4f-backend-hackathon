import { Controller, Get, Header, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { AuthErrorDto } from '../common/http/auth-error.dto';
import { PageQueryDto } from '../common/pagination.dto';
import { AdminRevenueService } from './admin-revenue.service';
import { AdminMarketerEarningsPageDto, AdminRevenueDto, AdminRevenueSummaryDto } from './dto/admin-revenue.dto';

@ApiTags('Admin revenue')
@ApiBearerAuth()
@ApiResponse({ status: 401, type: AuthErrorDto, description: 'AUTH_REQUIRED or SESSION_EXPIRED' })
@ApiResponse({ status: 403, type: AuthErrorDto, description: 'FORBIDDEN' })
@ApiResponse({ status: 409, type: AuthErrorDto, description: 'AMOUNT_OUT_OF_RANGE' })
@ApiResponse({ status: 500, type: AuthErrorDto, description: 'INTERNAL_ERROR' })
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
@Controller('admin/revenue')
export class AdminRevenueController {
  constructor(private readonly revenue: AdminRevenueService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Get all-time net platform fees from settled sales' })
  @ApiOkResponse({ type: AdminRevenueDto, headers: { 'Cache-Control': { schema: { type: 'string', enum: ['no-store'] } } } })
  getRevenue(): Promise<AdminRevenueDto> {
    return this.revenue.getRevenue();
  }

  @Get('summary')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Get all-time platform fees and marketer commissions from settled sales' })
  @ApiOkResponse({ type: AdminRevenueSummaryDto, headers: { 'Cache-Control': { schema: { type: 'string', enum: ['no-store'] } } } })
  getSummary(): Promise<AdminRevenueSummaryDto> {
    return this.revenue.getSummary();
  }

  @Get('marketers')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'List marketers with all-time settled sales and earned commissions' })
  @ApiOkResponse({ type: AdminMarketerEarningsPageDto, headers: { 'Cache-Control': { schema: { type: 'string', enum: ['no-store'] } } } })
  listMarketerEarnings(@Query() page: PageQueryDto): Promise<AdminMarketerEarningsPageDto> {
    return this.revenue.listMarketerEarnings(page);
  }
}
