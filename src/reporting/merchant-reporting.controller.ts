import { Controller, Get, Header, Query } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { CurrentActor, type AuthenticatedActor } from '../auth/authenticated-actor';
import { PageQueryDto } from '../common/pagination.dto';
import { MerchantDashboardDto, MerchantWalletDto, MerchantWalletTransactionPageDto } from './dto/merchant-reporting.dto';
import { PageValidation, ReportingAccess } from './reporting.decorators';
import { ReportingService } from './reporting.service';

@ApiTags('Merchant reporting')
@ReportingAccess('merchant')
@Controller('merchant')
export class MerchantReportingController {
  constructor(private readonly reports: ReportingService) {}

  @Get('wallet')
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ type: MerchantWalletDto })
  wallet(@CurrentActor() actor: AuthenticatedActor) {
    return this.reports.merchantWallet(actor.userId);
  }

  @Get('wallet/transactions')
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ type: MerchantWalletTransactionPageDto })
  @PageValidation()
  transactions(@CurrentActor() actor: AuthenticatedActor, @Query() page: PageQueryDto) {
    return this.reports.merchantTransactions(actor.userId, page);
  }

  @Get('dashboard')
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ type: MerchantDashboardDto })
  dashboard(@CurrentActor() actor: AuthenticatedActor) {
    return this.reports.merchantDashboard(actor.userId);
  }
}
