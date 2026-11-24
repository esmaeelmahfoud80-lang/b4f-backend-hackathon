import { ConflictException, HttpException, HttpStatus, Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { IdempotencyService } from '../common/idempotency/idempotency.service';
import { lockMarketerWallet } from '../common/marketer-wallet';
import { MAX_MONEY_MINOR_UNITS, toMoneyJsonInteger } from '../common/money';
import { readPage } from '../common/pagination';
import { Prisma, type PayoutRequest } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { AdminPayoutDto, PayoutDto, PayoutPageQueryDto } from './payout.dto';

const withMarketer = { marketer: { select: { name: true } } } as const;
type NamedPayout = Prisma.PayoutRequestGetPayload<{ include: typeof withMarketer }>;
type Decision = { status: 'confirmed' } | { status: 'rejected'; reason: string };

const conflicts = {
  INSUFFICIENT_WALLET_BALANCE: 'There is no available balance to withdraw.',
  PAYOUT_ALREADY_PENDING: 'A payout request is already pending.',
  PAYOUT_AMOUNT_CHANGED: 'The available amount has changed. Refresh the wallet and confirm again.',
  AMOUNT_OUT_OF_RANGE: 'The payout amount or balance exceeds the supported range.',
  INVALID_STATUS_TRANSITION: 'The payout already has a different decision.',
} as const;

function conflict(code: keyof typeof conflicts) {
  return new ConflictException({ statusCode: 409, code, message: conflicts[code] });
}

function payoutFailure(error: unknown): never {
  if (error instanceof HttpException) throw error;
  if (error instanceof RangeError) throw conflict('AMOUNT_OUT_OF_RANGE');
  throw new InternalServerErrorException({ statusCode: 500, code: 'INTERNAL_ERROR', message: 'Unable to complete the payout operation.' });
}

function payoutDto(record: PayoutRequest): PayoutDto {
  return { id: record.id, amountSyp: toMoneyJsonInteger(record.amountSyp), status: record.status,
    createdAt: record.createdAt.toISOString(), decidedAt: record.decidedAt?.toISOString() ?? null,
    rejectionReason: record.rejectionReason };
}

function adminPayoutDto(record: NamedPayout): AdminPayoutDto {
  return { ...payoutDto(record), marketerId: record.marketerId, marketerName: record.marketer.name };
}

@Injectable()
export class PayoutService {
  constructor(private readonly prisma: PrismaService, private readonly idempotency: IdempotencyService) {}

  create(marketerId: string, key: string, expectedAmountSyp: number) {
    return this.idempotency.execute<PayoutDto>({
      actorId: marketerId, operation: 'marketer.payout.create', key, payload: { expectedAmountSyp },
    }, async (tx) => {
      const wallet = await lockMarketerWallet(tx, marketerId);
      const pending = await tx.payoutRequest.findFirst({
        where: { marketerId, status: 'pending_review' }, select: { amountSyp: true },
      });
      if (wallet.pendingPayoutSyp !== (pending?.amountSyp ?? 0n)) throw new Error('Payout balance is inconsistent.');
      if (pending) throw conflict('PAYOUT_ALREADY_PENDING');
      const amountSyp = wallet.availableBalanceSyp;
      if (amountSyp === 0n) throw conflict('INSUFFICIENT_WALLET_BALANCE');
      if (amountSyp !== BigInt(expectedAmountSyp)) throw conflict('PAYOUT_AMOUNT_CHANGED');

      const record = await tx.payoutRequest.create({ data: { marketerId, walletId: wallet.id, amountSyp } });
      await tx.wallet.update({ where: { id: wallet.id }, data: { availableBalanceSyp: 0n, pendingPayoutSyp: amountSyp } });
      await tx.moneyMovement.create({ data: { kind: 'payout_hold', walletId: wallet.id, payoutId: record.id, amountSyp } });
      return { statusCode: HttpStatus.CREATED, body: payoutDto(record) };
    });
  }

  history(marketerId: string, query: PayoutPageQueryDto) {
    return this.list(query, { marketerId, status: query.status }, payoutDto);
  }

  adminHistory(query: PayoutPageQueryDto) {
    return this.list(query, { status: query.status }, adminPayoutDto);
  }

  private async list<T>(query: PayoutPageQueryDto, where: Prisma.PayoutRequestWhereInput, map: (record: NamedPayout) => T) {
    try {
      return await this.prisma.getClient().$transaction(async (tx) => {
        const total = await tx.payoutRequest.count({ where });
        return readPage(query, total, async (skip, take) => {
          const records = await tx.payoutRequest.findMany({
            where, skip, take, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], include: withMarketer,
          });
          return records.map(map);
        });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    } catch (error) {
      return payoutFailure(error);
    }
  }

  async decide(adminId: string, payoutId: string, decision: Decision): Promise<AdminPayoutDto> {
    try {
      return await this.prisma.getClient().$transaction(async (tx) => {
        const where = { id: payoutId };
        const owner = await tx.payoutRequest.findUnique({ where, select: { marketerId: true } });
        if (!owner) throw new NotFoundException({ statusCode: 404, code: 'NOT_FOUND', message: 'Payout request not found.' });

        // The owner lookup takes no lock. Decisions share the settlement wallet lock, then lock the payout.
        const wallet = await lockMarketerWallet(tx, owner.marketerId);
        const [{ decidedAt }] = await tx.$queryRaw<{ decidedAt: Date }[]>`
          SELECT clock_timestamp() AS "decidedAt" FROM payout_requests WHERE id = ${payoutId}::uuid FOR UPDATE
        `;
        const payout = await tx.payoutRequest.findUniqueOrThrow({ where, include: withMarketer });
        const reason = decision.status === 'rejected' ? decision.reason : null;
        if (payout.status === decision.status && payout.rejectionReason === reason) return adminPayoutDto(payout);
        if (payout.status !== 'pending_review') throw conflict('INVALID_STATUS_TRANSITION');
        if (wallet.id !== payout.walletId || wallet.pendingPayoutSyp !== payout.amountSyp) {
          throw new Error('Payout balance is inconsistent.');
        }

        const available = wallet.availableBalanceSyp + (decision.status === 'rejected' ? payout.amountSyp : 0n);
        if (available > MAX_MONEY_MINOR_UNITS) throw conflict('AMOUNT_OUT_OF_RANGE');
        if (decision.status === 'confirmed') {
          const { _sum } = await tx.payoutRequest.aggregate({
            where: { marketerId: owner.marketerId, status: 'confirmed' }, _sum: { amountSyp: true },
          });
          if ((_sum.amountSyp ?? 0n) + payout.amountSyp > MAX_MONEY_MINOR_UNITS) throw conflict('AMOUNT_OUT_OF_RANGE');
        }

        await tx.wallet.update({ where: { id: wallet.id }, data: { availableBalanceSyp: available, pendingPayoutSyp: 0n } });
        const result = await tx.payoutRequest.update({
          where, data: { status: decision.status, decidedById: adminId, decidedAt, rejectionReason: reason },
          include: withMarketer,
        });
        await tx.moneyMovement.create({ data: {
          kind: decision.status === 'confirmed' ? 'payout_completed' : 'payout_release_refund',
          walletId: wallet.id, payoutId, amountSyp: payout.amountSyp,
        } });
        return adminPayoutDto(result);
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    } catch (error) {
      return payoutFailure(error);
    }
  }
}
