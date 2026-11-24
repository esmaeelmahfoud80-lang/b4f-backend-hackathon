import { applyDecorators, BadRequestException, Body, Controller, Get, Header, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiHeader, ApiOkResponse, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentActor, type AuthenticatedActor } from '../auth/authenticated-actor';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { AuthErrorDto } from '../common/http/auth-error.dto';
import { IdempotencyKey } from '../common/idempotency/idempotency-key';
import { AdminPayoutDto, AdminPayoutPageDto, CreatePayoutDto, PayoutDto, PayoutPageDto, PayoutPageQueryDto, RejectPayoutDto } from './payout.dto';
import { PayoutService } from './payout.service';

const PayoutAccess = (role: 'marketer' | 'admin') => applyDecorators(
  UseGuards(JwtAuthGuard, RolesGuard), Roles(role), ApiBearerAuth(),
  ApiResponse({ status: 400, type: AuthErrorDto, description: 'VALIDATION_ERROR' }),
  ApiResponse({ status: 401, type: AuthErrorDto, description: 'AUTH_REQUIRED or SESSION_EXPIRED' }),
  ApiResponse({ status: 403, type: AuthErrorDto, description: 'FORBIDDEN' }),
  ApiResponse({ status: 500, type: AuthErrorDto, description: 'INTERNAL_ERROR' }),
);

const PayoutDecision = () => applyDecorators(
  Header('Cache-Control', 'no-store'),
  ApiOkResponse({ type: AdminPayoutDto }),
  ApiResponse({ status: 404, type: AuthErrorDto, description: 'NOT_FOUND' }),
  ApiResponse({ status: 409, type: AuthErrorDto, description: 'INVALID_STATUS_TRANSITION or AMOUNT_OUT_OF_RANGE' }),
);

@ApiTags('Simulated marketer payouts')
@PayoutAccess('marketer')
@Controller('marketer/payouts')
export class MarketerPayoutController {
  constructor(private readonly payouts: PayoutService) {}

  @Post()
  @Header('Cache-Control', 'no-store')
  @ApiHeader({ name: 'Idempotency-Key', required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiCreatedResponse({ type: PayoutDto })
  @ApiResponse({ status: 409, type: AuthErrorDto,
    description: 'INSUFFICIENT_WALLET_BALANCE, PAYOUT_ALREADY_PENDING, PAYOUT_AMOUNT_CHANGED or IDEMPOTENCY_KEY_REUSED' })
  async create(@CurrentActor() actor: AuthenticatedActor, @IdempotencyKey() key: string, @Body() input: CreatePayoutDto) {
    return (await this.payouts.create(actor.userId, key, input.expectedAmountSyp)).body;
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ type: PayoutPageDto })
  history(@CurrentActor() actor: AuthenticatedActor, @Query() query: PayoutPageQueryDto) {
    return this.payouts.history(actor.userId, query);
  }
}

@ApiTags('Admin simulated payouts')
@PayoutAccess('admin')
@Controller('admin/payouts')
export class AdminPayoutController {
  constructor(private readonly payouts: PayoutService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ type: AdminPayoutPageDto })
  history(@Query() query: PayoutPageQueryDto) {
    return this.payouts.adminHistory(query);
  }

  @Patch(':payoutId/approve')
  @PayoutDecision()
  approve(@CurrentActor() actor: AuthenticatedActor, @Param('payoutId', ParseUUIDPipe) id: string, @Body() body: unknown) {
    if (body !== undefined && (body === null || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 0)) {
      throw new BadRequestException('This operation does not accept request fields.');
    }
    return this.payouts.decide(actor.userId, id, { status: 'confirmed' });
  }

  @Patch(':payoutId/reject')
  @PayoutDecision()
  reject(@CurrentActor() actor: AuthenticatedActor, @Param('payoutId', ParseUUIDPipe) id: string, @Body() input: RejectPayoutDto) {
    return this.payouts.decide(actor.userId, id, { status: 'rejected', reason: input.reason });
  }
}
