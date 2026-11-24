import { Controller, Get, Header, Query } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { CurrentActor, type AuthenticatedActor } from '../auth/authenticated-actor';
import { PageQueryDto } from '../common/pagination.dto';
import { CustomerDashboardDto, CustomerPurchasePageDto } from './dto/customer-reporting.dto';
import { PageValidation, ReportingAccess } from './reporting.decorators';
import { ReportingService } from './reporting.service';

@ApiTags('Customer reporting')
@ReportingAccess('customer')
@Controller('customer')
export class CustomerReportingController {
  constructor(private readonly reports: ReportingService) {}

  @Get('dashboard')
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ type: CustomerDashboardDto })
  dashboard(@CurrentActor() actor: AuthenticatedActor) {
    return this.reports.customerDashboard(actor.userId);
  }

  @Get('purchases')
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ type: CustomerPurchasePageDto })
  @PageValidation()
  purchases(@CurrentActor() actor: AuthenticatedActor, @Query() page: PageQueryDto) {
    return this.reports.customerPurchases(actor.userId, page);
  }
}
