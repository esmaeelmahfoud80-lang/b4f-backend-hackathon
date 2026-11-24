import { ConflictException, Injectable, InternalServerErrorException } from '@nestjs/common';
import { toMoneyJsonInteger } from '../common/money';
import { readPage } from '../common/pagination';
import type { PageQueryDto } from '../common/pagination.dto';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { AdminMarketerEarningsPageDto, AdminRevenueDto, AdminRevenueSummaryDto } from './dto/admin-revenue.dto';

type RevenueTotals = { netFees: string; marketerCommission: string };
type MarketerTotals = { marketerId: string; salesCount: bigint; commission: string };

@Injectable()
export class AdminRevenueService {
  constructor(private readonly prisma: PrismaService) {}

  getRevenue(): Promise<AdminRevenueDto> {
    return this.readTotals(({ netFees }) => ({ netPlatformFeesSyp: toMoneyJsonInteger(BigInt(netFees)) }));
  }

  getSummary(): Promise<AdminRevenueSummaryDto> {
    return this.readTotals(({ netFees, marketerCommission }) => ({
      netPlatformFeesSyp: toMoneyJsonInteger(BigInt(netFees)),
      totalMarketerCommissionSyp: toMoneyJsonInteger(BigInt(marketerCommission)),
    }));
  }

  listMarketerEarnings(page: PageQueryDto): Promise<AdminMarketerEarningsPageDto> {
    return this.readReport(() => this.prisma.getClient().$transaction(async (tx) => {
      const where = { isMarketer: true };
      const total = await tx.user.count({ where });

      return readPage(page, total, async (skip, take) => {
        const marketers = await tx.user.findMany({
          where, skip, take, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          select: { id: true, name: true, phone: true },
        });
        if (!marketers.length) return [];

        const ids = Prisma.join(marketers.map(({ id }) => Prisma.sql`${id}::uuid`));
        const totals = await tx.$queryRaw<MarketerTotals[]>`
          SELECT cm.marketer_id AS "marketerId", COUNT(*) AS "salesCount",
            SUM(s.marketer_commission_syp)::text AS "commission"
          FROM campaign_marketers cm
          JOIN sales s ON s.campaign_marketer_id = cm.id
          WHERE cm.marketer_id IN (${ids})
          GROUP BY cm.marketer_id
        `;
        const byMarketer = new Map(totals.map((row) => [row.marketerId, row]));

        return marketers.map((marketer) => {
          const earnings = byMarketer.get(marketer.id);
          return {
            ...marketer,
            salesCount: Number(earnings?.salesCount ?? 0n),
            totalEarnedSyp: toMoneyJsonInteger(BigInt(earnings?.commission ?? '0')),
          };
        });
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }));
  }

  private readTotals<T>(map: (totals: RevenueTotals) => T): Promise<T> {
    return this.readReport(async () => {
      // PostgreSQL SUM(bigint) is numeric. Read it as text so it stays exact through the range check.
      const [total] = await this.prisma.getClient().$queryRaw<RevenueTotals[]>`
        SELECT COALESCE(SUM(platform_net_fee_syp), 0)::text AS "netFees",
          COALESCE(SUM(marketer_commission_syp), 0)::text AS "marketerCommission"
        FROM sales
      `;
      return map(total);
    });
  }

  private async readReport<T>(read: () => Promise<T>): Promise<T> {
    try {
      return await read();
    } catch (error) {
      if (error instanceof RangeError) {
        throw new ConflictException({ statusCode: 409, code: 'AMOUNT_OUT_OF_RANGE', message: 'A reported amount exceeds the supported range.' });
      }
      throw new InternalServerErrorException({ statusCode: 500, code: 'INTERNAL_ERROR', message: 'Unable to load the requested report.' });
    }
  }
}
