import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, InternalServerErrorException } from '@nestjs/common';
import { toMoneyJsonInteger } from '../common/money';
import { PrismaService } from '../prisma/prisma.service';
import { CampaignPreviewDto, CampaignPreviewInputDto } from './dto/campaign-preview.dto';
import { calculateProductPricing, CampaignPricingOverflowError, InvalidCampaignPricingError, percentToBasisPoints } from './campaign-pricing';

@Injectable()
export class CampaignPreviewService {
  constructor(private readonly prisma: PrismaService) {}

  async preview(merchantId: string, input: CampaignPreviewInputDto): Promise<CampaignPreviewDto> {
    try {
      const merchant = await this.prisma.getClient().user.findUnique({
        where: { id: merchantId },
        select: {
          merchantProfile: { select: { userId: true } },
          wallets: { where: { role: 'merchant' }, select: { availableBalanceSyp: true } },
        },
      });
      if (!merchant?.merchantProfile) {
        throw new ForbiddenException({ statusCode: 403, code: 'FORBIDDEN', message: 'A merchant profile is required.' });
      }
      // The contract requires verification for launch. Preview is available to any merchant.
      const [wallet] = merchant.wallets;
      if (!wallet) throw new Error('Merchant wallet is missing.');

      const { finalPriceSyp, sample, worstCaseReserveSyp } = calculateProductPricing({
        originalPriceSyp: BigInt(input.originalPriceSyp),
        discountBasisPoints: percentToBasisPoints(input.discountPercent),
        commission: { type: input.commission.type, amountSyp: BigInt(input.commission.amountSyp) },
        maxItems: input.maxItems,
      });
      return {
        finalPriceSyp: toMoneyJsonInteger(finalPriceSyp),
        sampleSaleAmountSyp: toMoneyJsonInteger(sample.customerPaidCashSyp),
        commissionPerUnitSyp: toMoneyJsonInteger(sample.marketerCommissionSyp),
        platformTotalFeeSampleSyp: toMoneyJsonInteger(sample.platformTotalFeeSyp),
        customerCashbackSampleSyp: toMoneyJsonInteger(sample.customerCashbackSyp),
        platformNetFeeSampleSyp: toMoneyJsonInteger(sample.platformNetFeeSyp),
        merchantNetSampleSyp: toMoneyJsonInteger(sample.merchantNetSyp),
        worstCaseReserveSyp: toMoneyJsonInteger(worstCaseReserveSyp),
        isAffordableByMerchant: wallet.availableBalanceSyp >= worstCaseReserveSyp,
        merchantAvailableBalanceSyp: toMoneyJsonInteger(wallet.availableBalanceSyp),
      };
    } catch (error) {
      if (error instanceof InvalidCampaignPricingError) throw new BadRequestException(error.message);
      if (error instanceof CampaignPricingOverflowError) {
        throw new ConflictException({ statusCode: 409, code: 'AMOUNT_OUT_OF_RANGE', message: error.message });
      }
      if (error instanceof HttpException) throw error;
      throw new InternalServerErrorException({ statusCode: 500, code: 'INTERNAL_ERROR', message: 'Unable to preview the campaign.' });
    }
  }
}
