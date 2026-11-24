import { ConflictException, ForbiddenException, HttpException, Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { discountedPrice, percentToBasisPoints } from '../campaign/campaign-pricing';
import { toMoneyJsonInteger } from '../common/money';
import { Prisma, type OfferQrPass } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { createOfferQrCodes, isReferralCode } from './referral-code';
import type { OfferQrPassDto, PublicOfferDto } from './referral.dto';

const publicShop = { merchant: { select: { shopName: true, shopDetails: true, verificationStatus: true } } } as const;
type Campaign = Prisma.CampaignGetPayload<{ include: typeof publicShop }>;
type Attribution = { campaignId: string; campaignMarketerId: string | null };
const readCommitted = { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted };

function referralNotFound() {
  return new NotFoundException({ statusCode: 404, code: 'NOT_FOUND', message: 'Referral offer not found.' });
}

function campaignEnded() {
  return new ConflictException({ statusCode: 409, code: 'CAMPAIGN_ENDED', message: 'This campaign has ended.' });
}

function referralFailure(error: unknown): never {
  if (error instanceof HttpException) throw error;
  if (error instanceof RangeError) {
    throw new ConflictException({ statusCode: 409, code: 'AMOUNT_OUT_OF_RANGE', message: 'The offer amount exceeds the supported range.' });
  }
  throw new InternalServerErrorException({ statusCode: 500, code: 'INTERNAL_ERROR', message: 'Unable to complete the referral operation.' });
}

function offerPrice(campaign: Campaign) {
  const discountPercent = campaign.discountPercent.toNumber();
  const originalPrice = campaign.campaignType === 'product' ? campaign.originalPriceSyp : null;
  return {
    discountPercent,
    originalPriceSyp: originalPrice === null ? null : toMoneyJsonInteger(originalPrice),
    finalPriceSyp: originalPrice === null ? null : toMoneyJsonInteger(discountedPrice(originalPrice, percentToBasisPoints(discountPercent))),
  };
}

function available(campaign: Campaign) {
  return campaign.status === 'active' && campaign.endsAt.getTime() > Date.now();
}

function mapPass(campaign: Campaign, pass: OfferQrPass): OfferQrPassDto {
  const { discountPercent, finalPriceSyp } = offerPrice(campaign);
  return {
    passId: pass.id, campaignId: campaign.id, campaignType: campaign.campaignType, productName: campaign.productName,
    shopName: campaign.merchant.shopName, discountPercent, finalPriceSyp,
    qrToken: pass.qrToken, passCode: pass.passCode, status: pass.status, createdAt: pass.createdAt.toISOString(),
  };
}

@Injectable()
export class ReferralService {
  constructor(private readonly prisma: PrismaService) {}

  async offer(code: string): Promise<PublicOfferDto> {
    try {
      return await this.prisma.getClient().$transaction(async (tx) => {
        const attribution = await this.resolve(tx, code);
        const campaign = await tx.campaign.findUnique({ where: { id: attribution.campaignId }, include: publicShop });
        if (!campaign || campaign.merchant.verificationStatus !== 'verified' || !available(campaign)) throw referralNotFound();
        return {
          campaignId: campaign.id, campaignType: campaign.campaignType, shopName: campaign.merchant.shopName,
          shopDetails: campaign.merchant.shopDetails, productName: campaign.productName, description: campaign.description,
          imageUrl: campaign.imageUrl, ...offerPrice(campaign), endsAt: campaign.endsAt.toISOString(), status: campaign.status,
          attributionLabel: attribution.campaignMarketerId === null ? 'Merchant direct' : 'Marketer referral',
        };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    } catch (error) {
      return referralFailure(error);
    }
  }

  async click(code: string): Promise<void> {
    try {
      await this.prisma.getClient().$transaction(async (tx) => {
        const { attribution, campaign } = await this.lockActiveReferral(tx, code);
        await tx.referralClick.create({ data: attribution, select: { id: true } });
        if (!available(campaign)) throw campaignEnded();
      }, readCommitted);
    } catch (error) {
      return referralFailure(error);
    }
  }

  async issue(code: string, customerId: string): Promise<{ statusCode: 200 | 201; body: OfferQrPassDto }> {
    try {
      return await this.prisma.getClient().$transaction(async (tx) => {
        const { attribution, campaign, referringMarketerId } = await this.lockActiveReferral(tx, code);
        if (referringMarketerId === customerId) {
          throw new ForbiddenException({ statusCode: 403, code: 'SELF_PROMOTION_FORBIDDEN', message: 'You cannot use your own marketer referral for a purchase.' });
        }
        const customer = await tx.customerProfile.findUnique({ where: { userId: customerId }, select: { userId: true } });
        if (!customer) {
          throw new ForbiddenException({ statusCode: 403, code: 'FORBIDDEN', message: 'A customer profile is required.' });
        }
        const scope = { ...attribution, customerId, status: 'active' as const };
        for (let attempt = 0; attempt < 3; attempt++) {
          const existing = await tx.offerQrPass.findFirst({ where: scope });
          if (!available(campaign)) throw campaignEnded();
          if (existing) return { statusCode: 200, body: mapPass(campaign, existing) };

          // ON CONFLICT DO NOTHING preserves this transaction on an active-pass or credential collision.
          const [created] = await tx.offerQrPass.createManyAndReturn({ data: { ...scope, ...createOfferQrCodes() }, skipDuplicates: true });
          if (created) {
            if (!available(campaign)) throw campaignEnded();
            return { statusCode: 201, body: mapPass(campaign, created) };
          }
        }
        const winner = await tx.offerQrPass.findFirst({ where: scope });
        if (!available(campaign)) throw campaignEnded();
        if (winner) return { statusCode: 200, body: mapPass(campaign, winner) };
        throw new Error('Could not allocate unique Offer QR credentials.');
      }, readCommitted);
    } catch (error) {
      return referralFailure(error);
    }
  }

  private async resolve(tx: Prisma.TransactionClient, code: string): Promise<Attribution> {
    if (!isReferralCode(code)) throw referralNotFound();
    const [membership, direct] = await Promise.all([
      tx.campaignMarketer.findUnique({ where: { referralCode: code }, select: { id: true, campaignId: true, status: true } }),
      tx.campaign.findUnique({ where: { directReferralCode: code }, select: { id: true } }),
    ]);
    // Separate uniqueness constraints cannot disambiguate a code present in both tables.
    if (membership && direct) throw referralNotFound();
    if (membership?.status === 'approved') return { campaignId: membership.campaignId, campaignMarketerId: membership.id };
    if (direct) return { campaignId: direct.id, campaignMarketerId: null };
    throw referralNotFound();
  }

  private async lockActiveReferral(tx: Prisma.TransactionClient, code: string) {
    const attribution = await this.resolve(tx, code);
    // Use the Step 07/08 campaign-first lock order before locking eligibility rows or touching passes.
    const [locked] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM campaigns WHERE id = ${attribution.campaignId}::uuid FOR UPDATE`;
    if (!locked) throw referralNotFound();
    const campaign = await tx.campaign.findUniqueOrThrow({ where: { id: locked.id }, include: publicShop });
    const [merchant] = await tx.$queryRaw<{ userId: string }[]>`
      SELECT user_id AS "userId" FROM merchant_profiles
      WHERE user_id = ${campaign.merchantId}::uuid AND verification_status = 'verified' FOR SHARE
    `;
    if (!merchant) throw referralNotFound();
    let referringMarketerId: string | null = null;
    if (attribution.campaignMarketerId === null) {
      if (campaign.directReferralCode !== code) throw referralNotFound();
    } else {
      const [approved] = await tx.$queryRaw<{ marketerId: string }[]>`
        SELECT marketer_id AS "marketerId" FROM campaign_marketers WHERE id = ${attribution.campaignMarketerId}::uuid
        AND campaign_id = ${campaign.id}::uuid AND referral_code = ${code} AND status = 'approved' FOR SHARE
      `;
      if (!approved) throw referralNotFound();
      referringMarketerId = approved.marketerId;
    }
    if (!available(campaign)) throw campaignEnded();
    return { attribution, campaign, referringMarketerId };
  }
}
