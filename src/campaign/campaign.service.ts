import { pageInfo } from '../common/pagination';
import {
  BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable,
  InternalServerErrorException, Logger, NotFoundException, OnModuleDestroy, OnModuleInit,
} from '@nestjs/common';
import { IdempotencyService } from '../common/idempotency/idempotency.service';
import { MAX_MONEY_MINOR_UNITS } from '../common/money';
import { Prisma, type MerchantVerificationStatus } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { calculateProductPricing, InvalidCampaignPricingError, percentToBasisPoints } from './campaign-pricing';
import { campaignMerchant, mapMerchantCampaigns } from './campaign-response';
import type { LaunchCampaignDto, MerchantCampaignDto, MerchantCampaignPageDto, MerchantCampaignQueryDto } from './dto/campaign.dto';

function campaignNotFound() {
  return new NotFoundException({ statusCode: 404, code: 'NOT_FOUND', message: 'Campaign not found.' });
}

function amountOutOfRange() {
  return new ConflictException({ statusCode: 409, code: 'AMOUNT_OUT_OF_RANGE', message: 'A monetary amount exceeds the supported range.' });
}

function campaignFailure(error: unknown): never {
  if (error instanceof HttpException) throw error;
  if (error instanceof RangeError) throw amountOutOfRange();
  throw new InternalServerErrorException({ statusCode: 500, code: 'INTERNAL_ERROR', message: 'Unable to complete the campaign operation.' });
}

@Injectable()
export class CampaignService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CampaignService.name);
  private expiryTimer?: ReturnType<typeof setInterval>;
  private expirySweep?: Promise<void>;

  constructor(private readonly prisma: PrismaService, private readonly idempotency: IdempotencyService) {}

  onModuleInit(): void {
    this.expiryTimer = setInterval(() => {
      if (this.expirySweep) return;
      this.expirySweep = this.reconcileExpired(new Date())
        .catch(() => this.logger.warn('Unable to complete the campaign expiry sweep.'))
        .finally(() => { this.expirySweep = undefined; });
    }, 60_000).unref();
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.expiryTimer);
    await this.expirySweep;
  }

  launch(merchantId: string, key: string, input: LaunchCampaignDto) {
    const endsAt = new Date(input.endsAt);
    if (Number.isNaN(endsAt.getTime())) throw new BadRequestException('Invalid campaign end time.');
    const payload = { ...input, commission: { ...input.commission }, endsAt: endsAt.toISOString() };

    return this.idempotency.execute<MerchantCampaignDto>({ actorId: merchantId, operation: 'merchant.campaign.launch', key, payload }, async (tx) => {
      try {
        if (endsAt <= new Date()) throw new BadRequestException('Campaign end time must be in the future.');
        const { worstCaseReserveSyp } = calculateProductPricing({
          originalPriceSyp: BigInt(input.originalPriceSyp), discountBasisPoints: percentToBasisPoints(input.discountPercent),
          commission: { type: input.commission.type, amountSyp: BigInt(input.commission.amountSyp) }, maxItems: input.maxItems,
        });
        const [merchant] = await tx.$queryRaw<{ verificationStatus: MerchantVerificationStatus }[]>`
          SELECT verification_status::text AS "verificationStatus" FROM merchant_profiles
          WHERE user_id = ${merchantId}::uuid FOR SHARE
        `;
        if (merchant?.verificationStatus !== 'verified') {
          throw new ForbiddenException({ statusCode: 403, code: 'MERCHANT_NOT_VERIFIED', message: 'A verified merchant profile is required to launch a campaign.' });
        }

        const wallet = await tx.wallet.findUniqueOrThrow({ where: { userId_role: { userId: merchantId, role: 'merchant' } }, select: { id: true } });
        const updated = await tx.wallet.updateMany({
          where: { id: wallet.id, availableBalanceSyp: { gte: worstCaseReserveSyp } },
          data: { availableBalanceSyp: { decrement: worstCaseReserveSyp } },
        });
        if (updated.count !== 1) {
          throw new ConflictException({ statusCode: 409, code: 'INSUFFICIENT_MERCHANT_BALANCE', message: 'Your available balance is lower than the required worst-case campaign reserve.' });
        }
        // Recheck time after potentially waiting for the wallet row.
        if (endsAt <= new Date()) throw new BadRequestException('Campaign end time must be in the future.');

        const campaign = await tx.campaign.create({
          data: {
            merchantId, campaignType: input.campaignType, productName: input.productName, description: input.description,
            imageUrl: input.imageUrl, originalPriceSyp: BigInt(input.originalPriceSyp), discountPercent: input.discountPercent,
            commissionType: input.commission.type, commissionValue: String(input.commission.amountSyp),
            maxItems: input.maxItems, joinMode: input.joinMode, endsAt, worstCaseReserveSyp, lockedBudgetSyp: worstCaseReserveSyp,
          },
          include: campaignMerchant,
        });
        await tx.moneyMovement.create({ data: {
          walletId: wallet.id, campaignId: campaign.id, kind: 'campaign_reserve_lock', amountSyp: worstCaseReserveSyp,
        } });
        const [body] = await mapMerchantCampaigns(tx, [campaign]);
        return { statusCode: 201, body };
      } catch (error) {
        if (error instanceof InvalidCampaignPricingError) throw new BadRequestException(error.message);
        return campaignFailure(error);
      }
    });
  }

  async list(merchantId: string, { page, pageSize, status }: MerchantCampaignQueryDto): Promise<MerchantCampaignPageDto> {
    try {
      await this.reconcileExpired(new Date(), merchantId);
      return await this.prisma.getClient().$transaction(async (tx) => {
        const where = { merchantId, status };
        const total = await tx.campaign.count({ where });
        const lastPage = Math.ceil(total / pageSize);
        const campaigns = page > lastPage ? [] : await tx.campaign.findMany({
          where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * pageSize,
          take: pageSize, include: campaignMerchant,
        });
        return { items: await mapMerchantCampaigns(tx, campaigns), ...pageInfo({ page, pageSize }, total) };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    } catch (error) {
      return campaignFailure(error);
    }
  }

  async detail(merchantId: string, campaignId: string): Promise<MerchantCampaignDto> {
    try {
      const client = this.prisma.getClient();
      const where = { id_merchantId: { id: campaignId, merchantId } };
      const now = new Date();
      const owned = await client.campaign.findUnique({ where, select: { status: true, endsAt: true } });
      if (!owned) throw campaignNotFound();
      if (owned.status === 'active' && owned.endsAt <= now) {
        await client.$transaction((tx) => this.closeInTransaction(tx, merchantId, campaignId, now), {
          isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        });
      }
      return await client.$transaction(async (tx) => {
        const campaign = await tx.campaign.findUnique({ where, include: campaignMerchant });
        if (!campaign) throw campaignNotFound();
        const [response] = await mapMerchantCampaigns(tx, [campaign]);
        return response;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    } catch (error) {
      return campaignFailure(error);
    }
  }

  async close(merchantId: string, campaignId: string): Promise<MerchantCampaignDto> {
    try {
      return await this.prisma.getClient().$transaction(async (tx) => {
        const campaign = await this.closeInTransaction(tx, merchantId, campaignId);
        const [response] = await mapMerchantCampaigns(tx, [campaign]);
        return response;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    } catch (error) {
      return campaignFailure(error);
    }
  }

  /** Close and release under the caller's transaction, including future final-sale settlement. */
  async closeInTransaction(tx: Prisma.TransactionClient, merchantId: string, campaignId: string, expiredBy?: Date) {
    const [locked] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM campaigns WHERE id = ${campaignId}::uuid AND merchant_id = ${merchantId}::uuid FOR UPDATE
    `;
    if (!locked) throw campaignNotFound();
    const campaign = await tx.campaign.findUniqueOrThrow({ where: { id: locked.id }, include: campaignMerchant });
    if (campaign.status === 'ended' || (expiredBy && campaign.endsAt > expiredBy)) return campaign;

    // The shared lock order is campaign, Offer QR passes, then the merchant wallet.
    await tx.offerQrPass.updateMany({ where: { campaignId, status: 'active' }, data: { status: 'expired' } });
    if (campaign.lockedBudgetSyp > 0n) {
      const wallet = await tx.wallet.findUniqueOrThrow({ where: { userId_role: { userId: merchantId, role: 'merchant' } }, select: { id: true } });
      const updated = await tx.wallet.updateMany({
        where: { id: wallet.id, availableBalanceSyp: { lte: MAX_MONEY_MINOR_UNITS - campaign.lockedBudgetSyp } },
        data: { availableBalanceSyp: { increment: campaign.lockedBudgetSyp } },
      });
      if (updated.count !== 1) throw amountOutOfRange();
      await tx.moneyMovement.create({ data: {
        walletId: wallet.id, campaignId, kind: 'campaign_reserve_unlock', amountSyp: campaign.lockedBudgetSyp,
      } });
    }
    return tx.campaign.update({ where: { id: campaignId }, data: { status: 'ended', lockedBudgetSyp: 0n, closedAt: new Date() }, include: campaignMerchant });
  }

  private async reconcileExpired(now: Date, merchantId?: string): Promise<void> {
    const client = this.prisma.getClient();
    const batchSize = 50;
    let after: string | undefined;
    while (true) {
      const due = await client.campaign.findMany({
        where: { merchantId, status: 'active', endsAt: { lte: now }, id: after ? { gt: after } : undefined },
        orderBy: { id: 'asc' }, take: batchSize, select: { id: true, merchantId: true },
      });
      for (const campaign of due) {
        try {
          await client.$transaction((tx) => this.closeInTransaction(tx, campaign.merchantId, campaign.id, now), {
            isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
          });
        } catch (error) {
          if (merchantId) throw error;
          this.logger.warn('Unable to reconcile an expired campaign.');
        }
      }
      if (due.length < batchSize) return;
      after = due[due.length - 1].id;
    }
  }
}
