import { Controller, Get, Header, Query } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { CurrentActor, type AuthenticatedActor } from '../auth/authenticated-actor';
import { PageQueryDto } from '../common/pagination.dto';
import { MarketerMerchantEarningsPageDto, MarketerStatsDto, MarketerWalletDto, MarketerWalletTransactionPageDto } from './dto/marketer-reporting.dto';
import { PageValidation, ReportingAccess } from './reporting.decorators';
import { ReportingService } from './reporting.service';

@ApiTags('Marketer reporting')
@ReportingAccess('marketer')
@Controller('marketer')
export class MarketerReportingController {
  constructor(private readonly reports: ReportingService) {}

  @Get('wallet')
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ type: MarketerWalletDto })
  wallet(@CurrentActor() actor: AuthenticatedActor) {
    return this.reports.marketerWallet(actor.userId);
  }

  @Get('wallet/by-merchant')
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ type: MarketerMerchantEarningsPageDto })
  @PageValidation()
  byMerchant(@CurrentActor() actor: AuthenticatedActor, @Query() page: PageQueryDto) {
    return this.reports.marketerEarnings(actor.userId, page);
  }

  @Get('wallet/transactions')
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ type: MarketerWalletTransactionPageDto })
  @PageValidation()
  transactions(@CurrentActor() actor: AuthenticatedActor, @Query() page: PageQueryDto) {
    return this.reports.marketerTransactions(actor.userId, page);
  }

  @Get('stats')
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ type: MarketerStatsDto })
  stats(@CurrentActor() actor: AuthenticatedActor) {
    return this.reports.marketerStats(actor.userId);
  }
}
