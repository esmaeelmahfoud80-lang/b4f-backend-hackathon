import { pageInfo } from '../common/pagination';
import { ConflictException, ForbiddenException, HttpException, HttpStatus, Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { IdempotencyService } from '../common/idempotency/idempotency.service';
import { MAX_MONEY_MINOR_UNITS, toMoneyJsonInteger } from '../common/money';
import { Prisma, type MerchantTopup, type MerchantVerificationStatus } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { AdminTopupPageDto, AdminTopupQueryDto, AdminTopupResultDto, CreateAdminTopupDto } from './dto/admin-topup.dto';

function topupFields(topup: MerchantTopup, shopName: string): Omit<AdminTopupResultDto, 'merchantNewAvailableBalanceSyp'> {
  return { topupId: topup.id, merchantId: topup.merchantId, shopName, amountSyp: toMoneyJsonInteger(topup.amountSyp),
    paymentMethod: topup.paymentMethod, referenceNote: topup.referenceNote, createdAt: topup.createdAt.toISOString() };
}

@Injectable()
export class AdminTopupService {
  constructor(private readonly prisma: PrismaService, private readonly idempotency: IdempotencyService) {}

  create(adminId: string, merchantId: string, key: string, input: CreateAdminTopupDto) {
    const targetId = merchantId.toLowerCase();
    const { amountSyp: requestedAmount, paymentMethod, referenceNote } = input;
    const payload = { merchantId: targetId, amountSyp: requestedAmount, paymentMethod, referenceNote };
    return this.idempotency.execute<AdminTopupResultDto>({
      actorId: adminId, operation: 'admin.merchant.topup', key, payload,
    }, async (tx) => {
      // Match campaign launch: claim the request, lock the merchant profile, then update the merchant wallet.
      const [merchant] = await tx.$queryRaw<{ status: MerchantVerificationStatus; shopName: string }[]>`
        SELECT verification_status::text AS status, shop_name AS "shopName"
        FROM merchant_profiles WHERE user_id = ${targetId}::uuid FOR SHARE
      `;
      if (!merchant) {
        throw new NotFoundException({ statusCode: 404, code: 'NOT_FOUND', message: 'Merchant profile not found.' });
      }
      if (merchant.status !== 'verified') {
        throw new ForbiddenException({ statusCode: 403, code: 'MERCHANT_NOT_VERIFIED', message: 'Only verified merchants can receive top-ups.' });
      }

      const amountSyp = BigInt(requestedAmount);
      const [currentWallet] = await tx.$queryRaw<{ id: string; availableSyp: bigint }[]>`
        SELECT id, available_balance_syp AS "availableSyp"
        FROM wallets WHERE user_id = ${targetId}::uuid AND role = 'merchant' FOR NO KEY UPDATE
      `;
      if (!currentWallet) throw new Error('Merchant wallet is missing.');

      // Take a fresh READ COMMITTED snapshot after the wallet lock. Campaign writes that move
      // reserves into or out of this wallet serialize here. A sale that skips the wallet only
      // reduces the reserve. Leave campaign rows unlocked since closure holds them first.
      const [reserves] = await tx.$queryRaw<{ remainingSyp: string }[]>`
        SELECT COALESCE(SUM(locked_budget_syp), 0)::text AS "remainingSyp"
        FROM campaigns WHERE merchant_id = ${targetId}::uuid AND locked_budget_syp > 0
      `;
      if (currentWallet.availableSyp + BigInt(reserves.remainingSyp) + amountSyp > MAX_MONEY_MINOR_UNITS) {
        throw new ConflictException({ statusCode: 409, code: 'AMOUNT_OUT_OF_RANGE', message: 'The credited merchant balance would exceed the supported range.' });
      }

      const walletId = currentWallet.id;
      const wallet = await tx.wallet.update({
        where: { id: walletId }, data: { availableBalanceSyp: { increment: amountSyp } },
        select: { availableBalanceSyp: true },
      });
      const topup = await tx.merchantTopup.create({
        data: { merchantId: targetId, adminId, amountSyp, paymentMethod, referenceNote,
          merchantNewAvailableBalanceSyp: wallet.availableBalanceSyp },
      });
      await tx.moneyMovement.create({ data: { kind: 'merchant_topup', amountSyp, topupId: topup.id, walletId } });
      return { statusCode: HttpStatus.CREATED, body: { ...topupFields(topup, merchant.shopName),
        merchantNewAvailableBalanceSyp: toMoneyJsonInteger(wallet.availableBalanceSyp) } };
    });
  }

  async list({ page, pageSize, merchantId }: AdminTopupQueryDto): Promise<AdminTopupPageDto> {
    const where: Prisma.MerchantTopupWhereInput = merchantId === undefined ? {} : { merchantId };
    try {
      return await this.prisma.getClient().$transaction(async (tx) => {
        const total = await tx.merchantTopup.count({ where });
        const lastPage = Math.ceil(total / pageSize);
        const topups = page > lastPage ? [] : await tx.merchantTopup.findMany({
          where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * pageSize, take: pageSize,
          include: { merchant: { select: { shopName: true } } },
        });
        return {
          items: topups.map((topup) => ({ ...topupFields(topup, topup.merchant.shopName),
            merchantNewAvailableBalanceSyp: topup.merchantNewAvailableBalanceSyp === null
              ? null : toMoneyJsonInteger(topup.merchantNewAvailableBalanceSyp) })),
          ...pageInfo({ page, pageSize }, total),
        };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new InternalServerErrorException({
        statusCode: 500, code: 'INTERNAL_ERROR', message: 'Unable to load merchant top-up history.',
      });
    }
  }
}
