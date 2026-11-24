import { type CanActivate, type ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { requireRequestAuth, type RequestWithAuth } from '../auth/authenticated-actor';

@Injectable()
export class VerifiedUploadMerchantGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const { account } = requireRequestAuth(context.switchToHttp().getRequest<RequestWithAuth>());
    if (account.merchant?.verificationStatus !== 'verified') {
      throw new ForbiddenException({
        statusCode: 403, code: 'MERCHANT_NOT_VERIFIED', message: 'A verified merchant profile is required.',
      });
    }
    return true;
  }
}
