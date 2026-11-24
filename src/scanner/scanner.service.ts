import { ConflictException, ForbiddenException, HttpException, Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { calculateSalePricing, discountedPrice, percentToBasisPoints } from '../campaign/campaign-pricing';
import { CampaignService } from '../campaign/campaign.service';
import { IdempotencyService } from '../common/idempotency/idempotency.service';
import { lockMarketerWallet } from '../common/marketer-wallet';
import { MAX_MONEY_MINOR_UNITS, toMoneyJsonInteger } from '../common/money';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { cashbackThresholds } from '../config/cashback-thresholds';
import { accrueCashback } from './cashback-milestone';
import type { OfferRedeemResultDto, ScannerOfferDto } from './scanner.dto';

const settlementRelations = {
  campaign: { include: { merchant: { select: { verificationStatus: true } } } },
  customer: { select: { user: { select: { name: true } } } },
  campaignMarketer: { select: { marketerId: true, status: true } },
} as const;
type SettlementPass = Prisma.OfferQrPassGetPayload<{ include: typeof settlementRelations }>;

const conflictMessages = {
  QR_ALREADY_REDEEMED: 'This Offer QR has already been redeemed.',
  QR_EXPIRED: 'This Offer QR has expired.',
  CAMPAIGN_ENDED: 'This campaign has ended.',
  CAMPAIGN_LIMIT_EXCEEDED: 'This sale would exceed the campaign cap.',
  INSUFFICIENT_LOCKED_BUDGET: 'The campaign reserve cannot cover this sale.',
  AMOUNT_OUT_OF_RANGE: 'A monetary amount or resulting balance is outside the supported range.',
} as const;

function scannerConflict(code: keyof typeof conflictMessages) {
  return new ConflictException({ statusCode: 409, code, message: conflictMessages[code] });
}

function passNotFound() {
  return new NotFoundException({ statusCode: 404, code: 'NOT_FOUND', message: 'Offer QR not found.' });
}

function scannerFailure(error: unknown): never {
  if (error instanceof HttpException) throw error;
  if (error instanceof RangeError) throw scannerConflict('AMOUNT_OUT_OF_RANGE');
  throw new InternalServerErrorException({ statusCode: 500, code: 'INTERNAL_ERROR', message: 'Unable to complete the scanner operation.' });
}

function requireLiveCampaign(campaign: SettlementPass['campaign'], now: Date) {
  if (campaign.status !== 'active' || campaign.endsAt <= now) throw scannerConflict('CAMPAIGN_ENDED');
}

@Injectable()
export class ScannerService {
  constructor(
    private readonly prisma: PrismaService, private readonly idempotency: IdempotencyService,
    private readonly campaigns: CampaignService, private readonly config: ConfigService,
  ) {}

  async lookup(merchantId: string, code: string): Promise<ScannerOfferDto> {
    try {
      return await this.prisma.getClient().$transaction(async (tx) => {
        const pass = await this.ownedPass(tx, merchantId, code);
        const { pricing } = await this.quote(tx, pass);
        const cash = toMoneyJsonInteger(pricing.customerPaidCashSyp);
        return {
          kind: 'offer_qr', passId: pass.id, campaignId: pass.campaignId, campaignType: 'product',
          productName: pass.campaign.productName, customerName: pass.customer.user.name,
          discountPercent: pass.campaign.discountPercent.toNumber(), finalPriceSyp: cash, maxQuantity: 1,
          availableQuantityOptions: [{ quantity: 1, customerPaidCashSyp: cash }], status: 'active',
        };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    } catch (error) {
      return scannerFailure(error);
    }
  }

  redeem(merchantId: string, key: string, code: string) {
    return this.idempotency.execute<OfferRedeemResultDto>({
      actorId: merchantId, operation: 'merchant.scanner.redeem-offer', key, payload: { code, quantity: 1 },
    }, async (tx) => {
      try {
        const body = await this.settle(tx, merchantId, code);
        return { statusCode: 201, body };
      } catch (error) {
        return scannerFailure(error);
      }
    });
  }

  private async ownedPass(tx: Prisma.TransactionClient, merchantId: string, code: string) {
    const [pass, ambiguous] = await tx.offerQrPass.findMany({
      where: { campaign: { merchantId }, OR: [{ qrToken: code }, { passCode: code }] },
      include: settlementRelations, take: 2,
    });
    if (!pass || ambiguous) throw passNotFound();
    return pass;
  }

  private async quote(tx: Prisma.TransactionClient, pass: SettlementPass) {
    const { campaign } = pass;
    if (campaign.merchant.verificationStatus !== 'verified') {
      throw new ForbiddenException({ statusCode: 403, code: 'MERCHANT_NOT_VERIFIED', message: 'A verified merchant profile is required.' });
    }
    if (pass.status === 'redeemed') throw scannerConflict('QR_ALREADY_REDEEMED');
    if (pass.status === 'expired') throw scannerConflict('QR_EXPIRED');
    requireLiveCampaign(campaign, new Date());
    if (campaign.campaignType !== 'product' || campaign.commissionType !== 'fixed' ||
        campaign.originalPriceSyp === null || campaign.maxItems === null ||
        (pass.campaignMarketerId !== null && pass.campaignMarketer?.status !== 'approved') ||
        pass.campaignMarketer?.marketerId === campaign.merchantId) throw passNotFound();

    const originalAmountSyp = campaign.originalPriceSyp;
    const finalPrice = discountedPrice(originalAmountSyp, percentToBasisPoints(campaign.discountPercent.toNumber()));
    const commission = pass.campaignMarketerId === null ? 0n : BigInt(campaign.commissionValue.toFixed(0));
    const pricing = calculateSalePricing(finalPrice, { type: 'fixed', amountSyp: commission }, 1);
    const { _sum } = await tx.sale.aggregate({ where: { campaignId: campaign.id }, _sum: { quantity: true, customerPaidCashSyp: true } });
    const itemsAfterSale = (_sum.quantity ?? 0) + 1;
    const volumeAfterSale = (_sum.customerPaidCashSyp ?? 0n) + pricing.customerPaidCashSyp;
    if (itemsAfterSale > campaign.maxItems || (campaign.maxSalesVolumeSyp !== null && volumeAfterSale > campaign.maxSalesVolumeSyp)) {
      throw scannerConflict('CAMPAIGN_LIMIT_EXCEEDED');
    }
    if (volumeAfterSale > MAX_MONEY_MINOR_UNITS) throw scannerConflict('AMOUNT_OUT_OF_RANGE');
    const totalDeductedReserveSyp = pricing.marketerCommissionSyp + pricing.platformTotalFeeSyp;
    if (campaign.lockedBudgetSyp < totalDeductedReserveSyp) throw scannerConflict('INSUFFICIENT_LOCKED_BUDGET');
    const finalSale = itemsAfterSale === campaign.maxItems || volumeAfterSale === campaign.maxSalesVolumeSyp;
    return { originalAmountSyp, pricing, totalDeductedReserveSyp, finalSale };
  }

  private async settle(tx: Prisma.TransactionClient, merchantId: string, code: string): Promise<OfferRedeemResultDto> {
    const candidate = await this.ownedPass(tx, merchantId, code);
    // Campaign, then pass: issuance and closing acquire the campaign row before touching passes.
    const [campaignLock] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM campaigns WHERE id = ${candidate.campaignId}::uuid AND merchant_id = ${merchantId}::uuid FOR UPDATE
    `;
    if (!campaignLock) throw passNotFound();
    const [passLock] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM offer_qr_passes WHERE id = ${candidate.id}::uuid AND campaign_id = ${campaignLock.id}::uuid FOR UPDATE
    `;
    if (!passLock) throw passNotFound();
    const [merchant] = await tx.$queryRaw<{ userId: string }[]>`
      SELECT user_id AS "userId" FROM merchant_profiles
      WHERE user_id = ${merchantId}::uuid AND verification_status = 'verified' FOR SHARE
    `;
    if (!merchant) {
      throw new ForbiddenException({ statusCode: 403, code: 'MERCHANT_NOT_VERIFIED', message: 'A verified merchant profile is required.' });
    }
    const pass = await tx.offerQrPass.findUniqueOrThrow({ where: { id: passLock.id }, include: settlementRelations });
    if (pass.qrToken !== code && pass.passCode !== code) throw passNotFound();
    if (pass.campaignMarketerId !== null) {
      const [membership] = await tx.$queryRaw<{ marketerId: string }[]>`
        SELECT marketer_id AS "marketerId" FROM campaign_marketers WHERE id = ${pass.campaignMarketerId}::uuid
        AND campaign_id = ${pass.campaignId}::uuid AND status = 'approved' FOR SHARE
      `;
      if (!membership || membership.marketerId !== pass.campaignMarketer?.marketerId) throw passNotFound();
      if (membership.marketerId === pass.customerId) {
        throw new ForbiddenException({ statusCode: 403, code: 'SELF_PROMOTION_FORBIDDEN', message: 'You cannot use your own marketer referral for a purchase.' });
      }
    }
    const { campaign } = pass;
    const { originalAmountSyp, pricing, totalDeductedReserveSyp, finalSale } = await this.quote(tx, pass);
    const marketerWallet = await this.lockMarketerWallet(tx, pass.campaignMarketer?.marketerId, pricing.marketerCommissionSyp);
    const [customerLock] = await tx.$queryRaw<{ userId: string }[]>`
      SELECT user_id AS "userId" FROM customer_profiles WHERE user_id = ${pass.customerId}::uuid FOR UPDATE
    `;
    if (!customerLock) throw passNotFound();
    const customer = await tx.customerProfile.findUniqueOrThrow({ where: { userId: pass.customerId } });
    const { minimumPurchases, minimumSpendSyp } = cashbackThresholds(this.config);
    const cashback = accrueCashback(customer, pricing.customerPaidCashSyp, pricing.customerCashbackSyp, minimumPurchases, minimumSpendSyp);
    const scannedAt = new Date();
    requireLiveCampaign(campaign, scannedAt);

    const claimed = await tx.offerQrPass.updateMany({ where: { id: pass.id, status: 'active' }, data: { status: 'redeemed', redeemedAt: scannedAt } });
    if (claimed.count !== 1) throw scannerConflict('QR_ALREADY_REDEEMED');
    const sale = await tx.sale.create({ data: {
      offerQrPassId: pass.id, campaignId: campaign.id, merchantId, campaignMarketerId: pass.campaignMarketerId,
      customerId: pass.customerId, attributionSource: pass.campaignMarketerId === null ? 'merchant_direct' : 'marketer',
      quantity: 1, originalAmountSyp, customerPaidCashSyp: pricing.customerPaidCashSyp,
      marketerCommissionSyp: pricing.marketerCommissionSyp, platformTotalFeeSyp: pricing.platformTotalFeeSyp,
      customerCashbackSyp: pricing.customerCashbackSyp, platformNetFeeSyp: pricing.platformNetFeeSyp, totalDeductedReserveSyp, scannedAt,
    }, select: { id: true } });
    const remaining = await tx.campaign.update({ where: { id: campaign.id },
      data: { lockedBudgetSyp: { decrement: totalDeductedReserveSyp } }, select: { lockedBudgetSyp: true, status: true } });
    if (marketerWallet) {
      await tx.wallet.update({ where: { id: marketerWallet.id }, data: { availableBalanceSyp: { increment: pricing.marketerCommissionSyp } } });
    }
    await tx.customerProfile.update({ where: { userId: pass.customerId }, data: cashback.update });

    const ledger = { saleId: sale.id, campaignId: campaign.id };
    const movements: Prisma.MoneyMovementCreateManyInput[] = [
      { ...ledger, kind: 'sale_reserve_debit', amountSyp: totalDeductedReserveSyp },
      { ...ledger, kind: 'customer_cashback_accrual', customerId: pass.customerId, amountSyp: pricing.customerCashbackSyp },
      { ...ledger, kind: 'platform_net_fee', amountSyp: pricing.platformNetFeeSyp },
    ];
    if (marketerWallet) movements.push({ ...ledger, kind: 'marketer_commission_credit', walletId: marketerWallet.id, amountSyp: pricing.marketerCommissionSyp });
    if (cashback.unlockedSyp > 0n) movements.push({ ...ledger, kind: 'customer_cashback_unlock', customerId: pass.customerId, amountSyp: cashback.unlockedSyp });
    await tx.moneyMovement.createMany({ data: movements });

    // Keep closure and surplus release in the same transaction as the final sale and its saved response.
    const after = finalSale ? await this.campaigns.closeInTransaction(tx, merchantId, campaign.id) : remaining;
    return {
      saleId: sale.id, campaignId: campaign.id, productName: campaign.productName, quantity: 1,
      originalAmountSyp: toMoneyJsonInteger(originalAmountSyp), customerPaidCashSyp: toMoneyJsonInteger(pricing.customerPaidCashSyp),
      marketerCommissionSyp: toMoneyJsonInteger(pricing.marketerCommissionSyp), platformTotalFeeSyp: toMoneyJsonInteger(pricing.platformTotalFeeSyp),
      customerCashbackSyp: toMoneyJsonInteger(pricing.customerCashbackSyp), platformNetFeeSyp: toMoneyJsonInteger(pricing.platformNetFeeSyp),
      remainingLockedBudgetSyp: toMoneyJsonInteger(after.lockedBudgetSyp), campaignStatusAfterSale: after.status, scannedAt: scannedAt.toISOString(),
    };
  }

  private async lockMarketerWallet(tx: Prisma.TransactionClient, marketerId: string | undefined, commission: bigint) {
    if (commission === 0n) return undefined;
    if (!marketerId) throw passNotFound();
    const wallet = await lockMarketerWallet(tx, marketerId);
    if (wallet.availableBalanceSyp + wallet.pendingPayoutSyp + commission > MAX_MONEY_MINOR_UNITS) {
      throw scannerConflict('AMOUNT_OUT_OF_RANGE');
    }
    return wallet;
  }

}
