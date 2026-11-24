import { pageInfo } from '../common/pagination';
import { ConflictException, HttpException, Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { accountRoles } from '../auth/account-roles';
import { toMoneyJsonInteger } from '../common/money';
import { Prisma, type MerchantVerificationStatus } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { AdminMerchantDto, AdminMerchantPageDto, AdminMerchantQueryDto, VerifyMerchantDto } from './dto/admin-merchant.dto';

const merchantAccount = {
  id: true, name: true, phone: true, isAdmin: true, isCustomer: true, isMarketer: true, createdAt: true,
  merchantProfile: { select: { shopName: true, shopDetails: true, verificationStatus: true, contractReference: true, creditLimitSyp: true } },
} as const;
type MerchantRecord = Prisma.UserGetPayload<{ select: typeof merchantAccount }>;

function adminMerchantFailure(error: unknown): never {
  if (error instanceof HttpException) throw error;
  if (error instanceof RangeError) {
    throw new ConflictException({ statusCode: 409, code: 'AMOUNT_OUT_OF_RANGE', message: 'A merchant balance exceeds the supported range.' });
  }
  throw new InternalServerErrorException({ statusCode: 500, code: 'INTERNAL_ERROR', message: 'Unable to complete the admin merchant operation.' });
}

@Injectable()
export class AdminMerchantService {
  constructor(private readonly prisma: PrismaService) {}

  async list({ page, pageSize, verificationStatus }: AdminMerchantQueryDto): Promise<AdminMerchantPageDto> {
    const where = { merchantProfile: verificationStatus === undefined ? { isNot: null } : { is: { verificationStatus } } };
    try {
      return await this.prisma.getClient().$transaction(async (tx) => {
        const total = await tx.user.count({ where });
        const lastPage = Math.ceil(total / pageSize);
        const records = page > lastPage ? [] : await tx.user.findMany({
          where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * pageSize,
          take: pageSize, select: merchantAccount,
        });
        return { items: await this.mapMerchants(tx, records), ...pageInfo({ page, pageSize }, total) };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    } catch (error) {
      return adminMerchantFailure(error);
    }
  }

  async verify(merchantId: string, input: VerifyMerchantDto): Promise<AdminMerchantDto> {
    try {
      return await this.prisma.getClient().$transaction(async (tx) => {
        // Serialize decisions on the same profile row that campaign launch reads under FOR SHARE.
        const [profile] = await tx.$queryRaw<{ status: MerchantVerificationStatus }[]>`
          SELECT verification_status::text AS status FROM merchant_profiles WHERE user_id = ${merchantId}::uuid FOR UPDATE
        `;
        if (!profile) throw new NotFoundException({ statusCode: 404, code: 'NOT_FOUND', message: 'Merchant profile not found.' });
        if (profile.status !== 'pending' && profile.status !== input.status) {
          throw new ConflictException({ statusCode: 409, code: 'INVALID_STATUS_TRANSITION', message: 'This merchant already has a verification decision.' });
        }
        const { contractReference } = input;
        if (profile.status !== input.status || contractReference !== undefined) {
          await tx.merchantProfile.update({ where: { userId: merchantId }, data: {
            verificationStatus: input.status, ...(contractReference === undefined ? {} : { contractReference }),
          } });
        }
        const record = await tx.user.findUniqueOrThrow({ where: { id: merchantId }, select: merchantAccount });
        const [result] = await this.mapMerchants(tx, [record]);
        return result;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    } catch (error) {
      return adminMerchantFailure(error);
    }
  }

  private async mapMerchants(tx: Prisma.TransactionClient, records: MerchantRecord[]): Promise<AdminMerchantDto[]> {
    if (records.length === 0) return [];
    const ids = Prisma.join(records.map(({ id }) => Prisma.sql`${id}::uuid`));
    // Read available funds and locked reserves together, even if a concurrent close is releasing a reserve.
    const wallets = await tx.$queryRaw<{ userId: string; availableSyp: bigint; lockedSyp: string }[]>`
      SELECT w.user_id AS "userId", w.available_balance_syp AS "availableSyp",
        COALESCE(SUM(c.locked_budget_syp), 0)::text AS "lockedSyp"
      FROM wallets w LEFT JOIN campaigns c ON c.merchant_id = w.user_id AND c.status = 'active'
      WHERE w.role = 'merchant' AND w.user_id IN (${ids})
      GROUP BY w.user_id, w.available_balance_syp
    `;
    const walletByUser = new Map(wallets.map((wallet) => [wallet.userId, wallet]));
    return records.map((record) => {
      const profile = record.merchantProfile;
      const wallet = walletByUser.get(record.id);
      if (!profile || !wallet) throw new Error('Merchant profile or wallet is missing.');
      return {
        id: record.id, name: record.name, phone: record.phone, roles: accountRoles(record), createdAt: record.createdAt.toISOString(),
        merchant: { name: profile.shopName, details: profile.shopDetails,
          verificationStatus: profile.verificationStatus, contractReference: profile.contractReference },
        wallet: { availableBalanceSyp: toMoneyJsonInteger(wallet.availableSyp),
          totalLockedReservesSyp: toMoneyJsonInteger(BigInt(wallet.lockedSyp)), creditLimitSyp: toMoneyJsonInteger(profile.creditLimitSyp) },
      };
    });
  }
}
