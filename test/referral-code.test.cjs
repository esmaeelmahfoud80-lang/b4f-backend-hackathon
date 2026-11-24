const assert = require('node:assert/strict');
const { Buffer } = require('node:buffer');
const test = require('node:test');
const { createOfferQrCodes, isReferralCode } = require('../dist/referral/referral-code');

test('referral codes use the existing case-sensitive URL alphabet and length limit', () => {
  for (const code of ['mk-demo01', 'md-direct', 'Upper_case', 'a'.repeat(128)]) assert.ok(isReferralCode(code));
  for (const code of ['', 'a'.repeat(129), 'a/b', 'abc\n', '%2F', 'with spaces']) assert.equal(isReferralCode(code), false);
});

test('Offer QR credentials use the seed token format and the OF fallback prefix', () => {
  const first = createOfferQrCodes();
  const second = createOfferQrCodes();
  assert.match(first.qrToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(first.qrToken, 'base64url').length, 32);
  assert.match(first.passCode, /^OF-[A-F0-9]{12}$/);
  assert.notEqual(first.qrToken, second.qrToken);
  assert.notEqual(first.passCode, second.passCode);
});
