import { randomBytes } from 'node:crypto';

export function isReferralCode(value: string): boolean {
  return value.length >= 1 && value.length <= 128 && !/[^A-Za-z0-9_-]/.test(value);
}

export function createOfferQrCodes() {
  return { qrToken: randomBytes(32).toString('base64url'), passCode: `OF-${randomBytes(6).toString('hex').toUpperCase()}` };
}
