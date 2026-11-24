import { ConflictException, Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { campaignConversionRate } from '../common/conversion-rate';
import { toMoneyJsonInteger } from '../common/money';
import type { PageQueryDto } from '../common/pagination.dto';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { cashbackThresholds } from '../config/cashback-thresholds';
import type { CustomerDashboardDto, CustomerPurchasePageDto } from './dto/customer-reporting.dto';
import { marketerKinds, type MarketerMerchantEarningsPageDto, type MarketerStatsDto, type MarketerWalletDto,
  type MarketerWalletTransactionPageDto } from './dto/marketer-reporting.dto';
import type { MerchantDashboardDto, MerchantWalletDto, MerchantWalletTransactionDto, MerchantWalletTransactionPageDto } from './dto/merchant-reporting.dto';
import { readPage } from '../common/pagination';

const newestMovement = [{ createdAt: 'desc' }, { id: 'desc' }] satisfies Prisma.MoneyMovementOrderByWithRelationInput[];
const saleTotals = Prisma.sql`COUNT(*) AS sales, COALESCE(SUM(quantity), 0) AS items,
  COALESCE(SUM(customer_paid_cash_syp), 0)::text AS cash,
  COALESCE(SUM(marketer_commission_syp), 0)::text AS commission,
  COALESCE(SUM(platform_total_fee_syp), 0)::text AS fees`;

type MerchantTotals = { sales: bigint; items: bigint; cash: string; commission: string; fees: string };
type MarketerTotals = { items: bigint; earned: string };
type MerchantEarningsRow = MarketerTotals & { merchantId: string; shopName: string; sales: bigint };

function sumMoney(value: string): number {
  return toMoneyJsonInteger(BigInt(value));
}

@Injectable()
export class ReportingService {
  constructor(private readonly prisma: PrismaService, private readonly config: ConfigService) {}

  private async read<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    try {
      return await this.prisma.getClient().$transaction(async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        return operation(tx);
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    } catch (error) {
      if (error instanceof RangeError) {
        throw new ConflictException({ statusCode: 409, code: 'AMOUNT_OUT_OF_RANGE', message: 'A reported amount exceeds the supported range.' });
      }
      throw new InternalServerErrorException({ statusCode: 500, code: 'INTERNAL_ERROR', message: 'Unable to load the requested report.' });
    }
  }

  private wallet(tx: Prisma.TransactionClient, userId: string, role: 'merchant' | 'marketer') {
    return tx.wallet.findUniqueOrThrow({ where: { userId_role: { userId, role } } });
  }

  private async merchantSummary(tx: Prisma.TransactionClient, userId: string) {
    const wallet = await this.wallet(tx, userId, 'merchant');
    const profile = await tx.merchantProfile.findUniqueOrThrow({ where: { userId },
      select: { verificationStatus: true, creditLimitSyp: true } });
    const [active] = await tx.$queryRaw<{ count: bigint; locked: string }[]>`
      SELECT COUNT(*) AS count, COALESCE(SUM(locked_budget_syp), 0)::text AS locked
      FROM campaigns WHERE merchant_id = ${userId}::uuid AND status = 'active'
    `;
    return { verificationStatus: profile.verificationStatus, activeCampaignsCount: Number(active.count), wallet: {
      availableBalanceSyp: toMoneyJsonInteger(wallet.availableBalanceSyp),
      totalLockedReservesSyp: sumMoney(active.locked),
      creditLimitSyp: toMoneyJsonInteger(profile.creditLimitSyp),
    } };
  }

  merchantWallet(userId: string): Promise<MerchantWalletDto> {
    return this.read(async (tx) => (await this.merchantSummary(tx, userId)).wallet);
  }

  merchantTransactions(userId: string, page: PageQueryDto): Promise<MerchantWalletTransactionPageDto> {
    return this.read(async (tx) => {
      const wallet = await this.wallet(tx, userId, 'merchant');
      // Settlement takes this debit from the campaign reserve and posts it without a wallet ID.
      const where: Prisma.MoneyMovementWhereInput = { OR: [
        { walletId: wallet.id, kind: { in: ['merchant_topup', 'campaign_reserve_lock', 'campaign_reserve_unlock'] } },
        { kind: 'sale_reserve_debit', campaign: { merchantId: userId } },
      ] };
      return readPage(page, await tx.moneyMovement.count({ where }), async (skip, take) => {
        const rows = await tx.moneyMovement.findMany({ where, skip, take, orderBy: newestMovement, include: {
          campaign: { select: { productName: true } }, topup: { select: { referenceNote: true } },
        } });
        return rows.map((row): MerchantWalletTransactionDto => ({
          id: row.id, kind: row.kind as MerchantWalletTransactionDto['kind'], amountSyp: toMoneyJsonInteger(row.amountSyp),
          campaignId: row.campaignId, campaignName: row.campaign?.productName ?? null,
          referenceNote: row.topup?.referenceNote ?? null, createdAt: row.createdAt.toISOString(),
        }));
      });
    });
  }

  merchantDashboard(userId: string): Promise<MerchantDashboardDto> {
    return this.read(async (tx) => {
      const summary = await this.merchantSummary(tx, userId);
      const clicks = await tx.referralClick.count({ where: { campaign: { merchantId: userId } } });
      const [totals] = await tx.$queryRaw<MerchantTotals[]>`
        SELECT ${saleTotals} FROM sales WHERE merchant_id = ${userId}::uuid
      `;
      const [top] = await tx.$queryRaw<{ id: string; name: string; cash: string; sales: bigint }[]>`
        SELECT c.id, c.product_name AS name, SUM(s.customer_paid_cash_syp)::text AS cash, COUNT(*) AS sales
        FROM sales s JOIN campaigns c ON c.id = s.campaign_id WHERE s.merchant_id = ${userId}::uuid
        GROUP BY c.id ORDER BY SUM(s.customer_paid_cash_syp) DESC, c.id ASC LIMIT 1
      `;
      const itemsSold = Number(totals.items);
      return { ...summary, topCampaign: top ? {
        campaignId: top.id, productName: top.name, grossCashSalesSyp: sumMoney(top.cash), salesCount: Number(top.sales),
      } : null, stats: {
        clicks, itemsSold, salesCount: Number(totals.sales), grossCashSalesSyp: sumMoney(totals.cash),
        commissionPaidSyp: sumMoney(totals.commission), platformFeesPaidSyp: sumMoney(totals.fees),
        conversionRatePercent: campaignConversionRate(itemsSold, clicks),
      } };
    });
  }

  private async marketerTotals(tx: Prisma.TransactionClient, userId: string) {
    const [totals] = await tx.$queryRaw<MarketerTotals[]>`
      SELECT COALESCE(SUM(s.quantity), 0) AS items, COALESCE(SUM(s.marketer_commission_syp), 0)::text AS earned
      FROM sales s JOIN campaign_marketers cm ON cm.id = s.campaign_marketer_id
      WHERE cm.marketer_id = ${userId}::uuid
    `;
    return totals;
  }

  marketerWallet(userId: string): Promise<MarketerWalletDto> {
    return this.read(async (tx) => {
      const wallet = await this.wallet(tx, userId, 'marketer');
      const totals = await this.marketerTotals(tx, userId);
      const { _sum } = await tx.payoutRequest.aggregate({
        where: { marketerId: userId, status: 'confirmed' }, _sum: { amountSyp: true },
      });
      return { availableBalanceSyp: toMoneyJsonInteger(wallet.availableBalanceSyp),
        pendingPayoutSyp: toMoneyJsonInteger(wallet.pendingPayoutSyp),
        totalEarnedSyp: sumMoney(totals.earned), totalConfirmedPaidOutSyp: toMoneyJsonInteger(_sum.amountSyp ?? 0n) };
    });
  }

  marketerEarnings(userId: string, page: PageQueryDto): Promise<MarketerMerchantEarningsPageDto> {
    return this.read(async (tx) => {
      const sales = Prisma.sql`FROM sales s JOIN campaign_marketers cm ON cm.id = s.campaign_marketer_id
        JOIN merchant_profiles m ON m.user_id = s.merchant_id
        WHERE cm.marketer_id = ${userId}::uuid`;
      const [count] = await tx.$queryRaw<{ total: bigint }[]>`SELECT COUNT(DISTINCT s.merchant_id) AS total ${sales}`;
      return readPage(page, Number(count.total), async (skip, take) => {
        const rows = await tx.$queryRaw<MerchantEarningsRow[]>`
          SELECT s.merchant_id AS "merchantId", COUNT(*) AS sales, SUM(s.quantity) AS items,
            SUM(s.marketer_commission_syp)::text AS earned, m.shop_name AS "shopName"
          ${sales}
          GROUP BY s.merchant_id, m.shop_name ORDER BY SUM(s.marketer_commission_syp) DESC, s.merchant_id ASC
          LIMIT ${take} OFFSET ${skip}
        `;
        return rows.map((row) => ({ merchantId: row.merchantId, shopName: row.shopName,
          salesCount: Number(row.sales), itemsSold: Number(row.items), totalEarnedSyp: sumMoney(row.earned) }));
      });
    });
  }

  marketerTransactions(userId: string, page: PageQueryDto): Promise<MarketerWalletTransactionPageDto> {
    return this.read(async (tx) => {
      const wallet = await this.wallet(tx, userId, 'marketer');
      const where = { walletId: wallet.id, kind: { in: [...marketerKinds] } } satisfies Prisma.MoneyMovementWhereInput;
      return readPage(page, await tx.moneyMovement.count({ where }), async (skip, take) => {
        const rows = await tx.moneyMovement.findMany({ where, skip, take, orderBy: newestMovement, include: {
          campaign: { select: { productName: true, merchant: { select: { shopName: true } } } },
        } });
        return rows.map((row) => ({
          id: row.id, kind: row.kind as (typeof marketerKinds)[number], amountSyp: toMoneyJsonInteger(row.amountSyp), campaignId: row.campaignId,
          campaignName: row.campaign?.productName ?? null, shopName: row.campaign?.merchant.shopName ?? null,
          createdAt: row.createdAt.toISOString(),
        }));
      });
    });
  }

  marketerStats(userId: string): Promise<MarketerStatsDto> {
    return this.read(async (tx) => {
      const totals = await this.marketerTotals(tx, userId);
      const clicks = await tx.referralClick.count({ where: { campaignMarketer: { marketerId: userId } } });
      const itemsSold = Number(totals.items);
      return { clicks, itemsSold, earnedSyp: sumMoney(totals.earned), conversionRatePercent: campaignConversionRate(itemsSold, clicks) };
    });
  }

  customerDashboard(userId: string): Promise<CustomerDashboardDto> {
    return this.read(async (tx) => {
      const profile = await tx.customerProfile.findUniqueOrThrow({ where: { userId } });
      const { minimumPurchases, minimumSpendSyp } = cashbackThresholds(this.config);
      const [lifetime] = await tx.$queryRaw<{ unlocked: string }[]>`
        SELECT COALESCE(SUM(amount_syp), 0)::text AS unlocked FROM money_movements
        WHERE customer_id = ${userId}::uuid AND kind = 'customer_cashback_unlock'
      `;
      return { verifiedPurchaseCount: profile.verifiedPurchaseCount, milestonePurchaseCount: profile.milestonePurchaseCount,
        milestonePurchasesRequired: minimumPurchases, milestoneSpendSyp: toMoneyJsonInteger(profile.milestoneSpendSyp),
        milestoneSpendRequiredSyp: toMoneyJsonInteger(minimumSpendSyp), lockedCashbackSyp: toMoneyJsonInteger(profile.lockedCashbackSyp),
        availableCashbackSyp: toMoneyJsonInteger(profile.availableCashbackSyp), totalCashbackUnlockedSyp: sumMoney(lifetime.unlocked) };
    });
  }

  customerPurchases(userId: string, page: PageQueryDto): Promise<CustomerPurchasePageDto> {
    return this.read(async (tx) => {
      const where = { customerId: userId };
      return readPage(page, await tx.sale.count({ where }), async (skip, take) => {
        const rows = await tx.sale.findMany({ where, skip, take, orderBy: [{ scannedAt: 'desc' }, { id: 'desc' }],
          select: { id: true, quantity: true, customerPaidCashSyp: true, customerCashbackSyp: true, scannedAt: true,
            merchant: { select: { shopName: true } }, campaign: { select: { productName: true } } },
        });
        return rows.map((row) => ({ saleId: row.id, shopName: row.merchant.shopName, productName: row.campaign.productName,
          quantity: row.quantity, customerPaidCashSyp: toMoneyJsonInteger(row.customerPaidCashSyp),
          cashbackEarnedSyp: toMoneyJsonInteger(row.customerCashbackSyp), scannedAt: row.scannedAt.toISOString() }));
      });
    });
  }
}
