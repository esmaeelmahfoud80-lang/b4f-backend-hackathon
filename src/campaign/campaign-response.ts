import { campaignConversionRate } from '../common/conversion-rate';
import { toMoneyJsonInteger } from '../common/money';
import type { Prisma } from '../generated/prisma/client';
import type { CampaignDto, MerchantCampaignDto } from './dto/campaign.dto';
import { calculateSalePricing, discountedPrice, percentToBasisPoints } from './campaign-pricing';

export const campaignMerchant = { merchant: { select: { shopName: true } } } as const;
export type CampaignRecord = Prisma.CampaignGetPayload<{ include: typeof campaignMerchant }>;

export function mapCampaign(campaign: CampaignRecord): CampaignDto {
  const discountPercent = campaign.discountPercent.toNumber();
  const commission = campaign.commissionType === 'fixed'
    ? { type: 'fixed' as const, amountSyp: BigInt(campaign.commissionValue.toFixed(0)) }
    : { type: 'percentage' as const, basisPoints: percentToBasisPoints(campaign.commissionValue.toNumber()) };
  const originalPrice = campaign.campaignType === 'product' ? campaign.originalPriceSyp : null;
  const finalPrice = originalPrice === null ? null : discountedPrice(originalPrice, percentToBasisPoints(discountPercent));

  return {
    id: campaign.id, campaignType: campaign.campaignType, shopName: campaign.merchant.shopName,
    productName: campaign.productName, description: campaign.description, imageUrl: campaign.imageUrl,
    originalPriceSyp: originalPrice === null ? null : toMoneyJsonInteger(originalPrice), discountPercent,
    finalPriceSyp: finalPrice === null ? null : toMoneyJsonInteger(finalPrice),
    commission: commission.type === 'fixed'
      ? { type: 'fixed', amountSyp: toMoneyJsonInteger(commission.amountSyp) }
      : { type: 'percentage', percent: campaign.commissionValue.toNumber() },
    commissionPerItemSyp: finalPrice === null ? null : toMoneyJsonInteger(calculateSalePricing(finalPrice, commission, 1).marketerCommissionSyp),
    joinMode: campaign.joinMode, status: campaign.status, endsAt: campaign.endsAt.toISOString(),
  };
}

export async function mapMerchantCampaigns(tx: Prisma.TransactionClient, campaigns: CampaignRecord[]): Promise<MerchantCampaignDto[]> {
  if (campaigns.length === 0) return [];
  const campaignId = { in: campaigns.map(({ id }) => id) };
  const [sales, referrals] = await Promise.all([
    tx.sale.groupBy({
      by: ['campaignId'], where: { campaignId }, _count: { _all: true },
      _sum: { quantity: true, customerPaidCashSyp: true, marketerCommissionSyp: true, platformTotalFeeSyp: true },
    }),
    tx.referralClick.groupBy({ by: ['campaignId'], where: { campaignId }, _count: { _all: true } }),
  ]);
  const salesByCampaign = new Map(sales.map((row) => [row.campaignId, row]));
  const clicksByCampaign = new Map(referrals.map((row) => [row.campaignId, row._count._all]));

  return campaigns.map((campaign) => {
    const salesTotals = salesByCampaign.get(campaign.id);
    const clicks = clicksByCampaign.get(campaign.id) ?? 0;
    const itemsSold = salesTotals?._sum.quantity ?? 0;
    const salesVolume = salesTotals?._sum.customerPaidCashSyp ?? 0n;
    const grossCashSalesSyp = toMoneyJsonInteger(salesVolume);
    const commissionPaidSyp = toMoneyJsonInteger(salesTotals?._sum.marketerCommissionSyp ?? 0n);
    const platformFeesPaidSyp = toMoneyJsonInteger(salesTotals?._sum.platformTotalFeeSyp ?? 0n);
    const volumeLeft = campaign.maxSalesVolumeSyp === null ? null : campaign.maxSalesVolumeSyp - salesVolume;

    return {
      ...mapCampaign(campaign), directReferralUrl: null,
      usage: {
        maxItems: campaign.maxItems, itemsSold,
        itemsLeft: campaign.maxItems === null ? null : Math.max(0, campaign.maxItems - itemsSold),
        maxSalesVolumeSyp: campaign.maxSalesVolumeSyp === null ? null : toMoneyJsonInteger(campaign.maxSalesVolumeSyp),
        salesVolumeSyp: grossCashSalesSyp,
        salesVolumeLeftSyp: volumeLeft === null ? null : toMoneyJsonInteger(volumeLeft < 0n ? 0n : volumeLeft),
        worstCaseReserveSyp: toMoneyJsonInteger(campaign.worstCaseReserveSyp),
        lockedBudgetSyp: toMoneyJsonInteger(campaign.lockedBudgetSyp), commissionsPaidSyp: commissionPaidSyp, platformFeesPaidSyp,
      },
      stats: { clicks, salesCount: salesTotals?._count._all ?? 0, itemsSold,
        grossCashSalesSyp, commissionPaidSyp, platformFeesPaidSyp, conversionRatePercent: campaignConversionRate(itemsSold, clicks) },
    };
  });
}
