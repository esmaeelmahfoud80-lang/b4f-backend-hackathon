import { pageInfo } from '../common/pagination';
import { ConflictException, ForbiddenException, HttpException, Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { toMoneyJsonInteger } from '../common/money';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { campaignConversionRate } from '../common/conversion-rate';
import { campaignMerchant, mapCampaign } from './campaign-response';
import type {
  CampaignDiscoveryQueryDto, DiscoverableCampaignPageDto, MarketerMembershipDto, MarketerMembershipLookupDto,
  MarketerMembershipPageDto, MarketerMembershipQueryDto,
} from './dto/marketer-campaign.dto';

const membershipCampaign = { campaign: { include: campaignMerchant } } as const;
type MembershipRecord = Prisma.CampaignMarketerGetPayload<{ include: typeof membershipCampaign }>;
const demoCampaign = { campaignType: 'product', joinMode: 'open', commissionType: 'fixed' } as const;
const readSnapshot = { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead };

function campaignNotFound() {
  return new NotFoundException({ statusCode: 404, code: 'NOT_FOUND', message: 'Campaign not found.' });
}

function campaignFailure(error: unknown): never {
  if (error instanceof HttpException) throw error;
  if (error instanceof RangeError) {
    throw new ConflictException({ statusCode: 409, code: 'AMOUNT_OUT_OF_RANGE', message: 'A monetary amount exceeds the supported range.' });
  }
  throw new InternalServerErrorException({ statusCode: 500, code: 'INTERNAL_ERROR', message: 'Unable to complete the campaign operation.' });
}

function visibleCampaign(now: Date): Prisma.CampaignWhereInput {
  return { ...demoCampaign, status: 'active', endsAt: { gt: now }, merchant: { verificationStatus: 'verified' } };
}

@Injectable()
export class MarketerCampaignService {
  constructor(private readonly prisma: PrismaService, private readonly config: ConfigService) {}

  async discover(query: CampaignDiscoveryQueryDto): Promise<DiscoverableCampaignPageDto> {
    if ((query.campaignType && query.campaignType !== demoCampaign.campaignType) ||
        (query.joinMode && query.joinMode !== demoCampaign.joinMode)) {
      return { ...pageInfo(query, 0), items: [] };
    }
    // Escape LIKE metacharacters so search text matches literally.
    const search = query.q?.replace(/[\\%_]/g, '\\$&');
    const where: Prisma.CampaignWhereInput = {
      ...visibleCampaign(new Date()),
      ...(search && { OR: [
        { productName: { contains: search, mode: 'insensitive' } },
        { merchant: { shopName: { contains: search, mode: 'insensitive' } } },
      ] }),
    };
    try {
      return await this.prisma.getClient().$transaction(async (tx) => {
        const total = await tx.campaign.count({ where });
        const campaigns = query.page > Math.ceil(total / query.pageSize) ? [] : await tx.campaign.findMany({
          where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (query.page - 1) * query.pageSize,
          take: query.pageSize, include: campaignMerchant,
        });
        return { ...pageInfo(query, total), items: campaigns.map(mapCampaign) };
      }, readSnapshot);
    } catch (error) {
      return campaignFailure(error);
    }
  }

  async detail(campaignId: string) {
    try {
      const campaign = await this.prisma.getClient().campaign.findFirst({
        where: { id: campaignId, ...visibleCampaign(new Date()) }, include: campaignMerchant,
      });
      if (!campaign) throw campaignNotFound();
      return mapCampaign(campaign);
    } catch (error) {
      return campaignFailure(error);
    }
  }

  async join(marketerId: string, campaignId: string): Promise<{ statusCode: 200 | 201; body: MarketerMembershipDto }> {
    try {
      return await this.prisma.getClient().$transaction(async (tx) => {
        // Close and expiry also lock this row first, so eligibility is checked after any competing close.
        const [locked] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM campaigns WHERE id = ${campaignId}::uuid FOR UPDATE`;
        if (!locked) throw campaignNotFound();
        const campaign = await tx.campaign.findUniqueOrThrow({ where: { id: locked.id } });
        const [verified] = await tx.$queryRaw<{ userId: string }[]>`
          SELECT user_id AS "userId" FROM merchant_profiles
          WHERE user_id = ${campaign.merchantId}::uuid AND verification_status = 'verified' FOR SHARE
        `;
        if (!verified || campaign.campaignType !== demoCampaign.campaignType ||
            campaign.joinMode !== demoCampaign.joinMode || campaign.commissionType !== demoCampaign.commissionType) {
          throw campaignNotFound();
        }
        if (campaign.status === 'ended' || campaign.endsAt <= new Date()) {
          throw new ConflictException({ statusCode: 409, code: 'CAMPAIGN_ENDED', message: 'This campaign has ended.' });
        }
        if (campaign.merchantId === marketerId) {
          throw new ForbiddenException({ statusCode: 403, code: 'SELF_PROMOTION_FORBIDDEN', message: 'You cannot join your own campaign.' });
        }

        const where = { campaignId_marketerId: { campaignId, marketerId } };
        const existing = await tx.campaignMarketer.findUnique({ where, include: membershipCampaign });
        if (existing?.status === 'pending') {
          throw new ConflictException({ statusCode: 409, code: 'JOIN_REQUEST_PENDING', message: 'This join request is already pending.' });
        }
        const requestedAt = new Date();
        if (campaign.endsAt <= requestedAt) {
          throw new ConflictException({ statusCode: 409, code: 'CAMPAIGN_ENDED', message: 'This campaign has ended.' });
        }
        let membership: MembershipRecord;
        if (existing?.status === 'approved' && existing.referralCode) {
          membership = existing;
        } else {
          const data = { status: 'approved' as const, referralCode: `mk-${randomBytes(16).toString('hex')}`,
            requestedAt: existing?.status === 'approved' ? existing.requestedAt : requestedAt };
          membership = existing
            ? await tx.campaignMarketer.update({ where, data, include: membershipCampaign })
            : await tx.campaignMarketer.create({ data: { campaignId, marketerId, ...data }, include: membershipCampaign });
        }
        const [body] = await this.mapMemberships(tx, [membership]);
        return { statusCode: existing ? 200 : 201, body };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    } catch (error) {
      return campaignFailure(error);
    }
  }

  async membership(marketerId: string, campaignId: string): Promise<MarketerMembershipLookupDto> {
    try {
      return await this.prisma.getClient().$transaction(async (tx) => {
        const record = await tx.campaignMarketer.findUnique({ where: { campaignId_marketerId: { campaignId, marketerId } }, include: membershipCampaign });
        if (!record) return { membership: null };
        const [membership] = await this.mapMemberships(tx, [record]);
        return { membership };
      }, readSnapshot);
    } catch (error) {
      return campaignFailure(error);
    }
  }

  async memberships(marketerId: string, query: MarketerMembershipQueryDto): Promise<MarketerMembershipPageDto> {
    try {
      return await this.prisma.getClient().$transaction(async (tx) => {
        const where = { marketerId, status: query.status };
        const total = await tx.campaignMarketer.count({ where });
        const records = query.page > Math.ceil(total / query.pageSize) ? [] : await tx.campaignMarketer.findMany({
          where, orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }], skip: (query.page - 1) * query.pageSize,
          take: query.pageSize, include: membershipCampaign,
        });
        return { ...pageInfo(query, total), items: await this.mapMemberships(tx, records) };
      }, readSnapshot);
    } catch (error) {
      return campaignFailure(error);
    }
  }

  private async mapMemberships(tx: Prisma.TransactionClient, records: MembershipRecord[]): Promise<MarketerMembershipDto[]> {
    if (records.length === 0) return [];
    const membershipIds = { in: records.map(({ id }) => id) };
    const [clicks, sales] = await Promise.all([
      tx.referralClick.groupBy({ by: ['campaignMarketerId'], where: { campaignMarketerId: membershipIds }, _count: { _all: true } }),
      tx.sale.groupBy({ by: ['campaignMarketerId'], where: { campaignMarketerId: membershipIds },
        _sum: { quantity: true, marketerCommissionSyp: true } }),
    ]);
    const clicksByMembership = new Map(clicks.map((row) => [row.campaignMarketerId, row._count._all]));
    const salesByMembership = new Map(sales.map((row) => [row.campaignMarketerId, row._sum]));
    return records.map((record) => {
      const clickCount = clicksByMembership.get(record.id) ?? 0;
      const totals = salesByMembership.get(record.id);
      const itemsSold = totals?.quantity ?? 0;
      return {
        id: record.id, status: record.status, requestedAt: record.requestedAt.toISOString(), campaign: mapCampaign(record.campaign),
        referralUrl: record.status === 'approved' && record.referralCode ? this.referralUrl(record.referralCode) : null,
        stats: { clicks: clickCount, itemsSold, earnedSyp: toMoneyJsonInteger(totals?.marketerCommissionSyp ?? 0n),
          conversionRatePercent: campaignConversionRate(itemsSold, clickCount) },
      };
    });
  }

  private referralUrl(code: string): string {
    const origin = new URL(this.config.get<string>('WEB_BASE_URL') ?? 'http://localhost:3001');
    if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password ||
        origin.pathname !== '/' || origin.search || origin.hash) throw new Error('Invalid web origin.');
    return new URL(`/r/${encodeURIComponent(code)}`, origin).href;
  }
}
