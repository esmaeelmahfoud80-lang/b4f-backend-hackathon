const assert = require('node:assert/strict');
const test = require('node:test');
const { plainToInstance } = require('class-transformer');
const { validate } = require('class-validator');
const { AdminMerchantQueryDto, VerifyMerchantDto } = require('../dist/admin/dto/admin-merchant.dto');

test('admin merchant query validates inherited pagination and verification filters', async () => {
  const options = { whitelist: true, forbidNonWhitelisted: true };
  const defaults = plainToInstance(AdminMerchantQueryDto, {});
  assert.equal(defaults.page, 1);
  assert.equal(defaults.pageSize, 20);
  for (const verificationStatus of ['pending', 'verified', 'rejected']) {
    const query = plainToInstance(AdminMerchantQueryDto, { page: '2', pageSize: '100', verificationStatus });
    assert.equal(query.page, 2);
    assert.equal(query.pageSize, 100);
    assert.deepEqual(await validate(query, options), []);
  }
  for (const body of [{ page: '0' }, { page: '1.5' }, { page: ['1', '2'] }, { pageSize: '101' }, { verificationStatus: 'approved' }, { role: 'admin' }]) {
    assert.ok((await validate(plainToInstance(AdminMerchantQueryDto, body), options)).length);
  }
});

test('verification accepts only a decision and an optional string reference', async () => {
  const options = { whitelist: true, forbidNonWhitelisted: true };
  const check = (body) => validate(plainToInstance(VerifyMerchantDto, body), options);
  assert.deepEqual(await check({ status: 'verified', contractReference: 'CONTRACT-001' }), []);
  assert.deepEqual(await check({ status: 'rejected' }), []);
  for (const body of [{}, { status: 'pending' }, { status: 'verified', contractReference: null },
    { status: 'verified', contractReference: 1 }, { status: 'verified', contractReference: 'a'.repeat(257) },
    { status: 'rejected', merchantId: 'other-user' }, { status: 'verified', roles: ['admin'] }]) {
    assert.ok((await check(body)).length);
  }
});
