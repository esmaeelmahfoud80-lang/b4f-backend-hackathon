const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const test = require('node:test');
const { Blob, Buffer } = require('node:buffer');
const { ConfigService } = require('@nestjs/config');
const { JwtService } = require('@nestjs/jwt');
const { plainToInstance } = require('class-transformer');
const { validate } = require('class-validator');
const sharp = require('sharp');

const { AbortSignal, FormData } = globalThis;
const endpoint = 'https://delivery.example.test/test-account';
const secret = randomBytes(32).toString('base64url');
Object.assign(process.env, {
  NODE_ENV: 'test', JWT_SECRET: secret, DATABASE_URL: 'postgresql://offline@127.0.0.1:1/media_unit_test',
  IMAGEKIT_PRIVATE_KEY: '', IMAGEKIT_URL_ENDPOINT: '',
});
const { createApp } = require('../dist/main');
const { PrismaService } = require('../dist/prisma/prisma.service');
const { LaunchCampaignDto } = require('../dist/campaign/dto/campaign.dto');
const { validateApiConfig } = require('../dist/config/api-config');
const { ImageProcessingService, MAX_IMAGE_BYTES } = require('../dist/media/image-processing.service');
const { MediaService } = require('../dist/media/media.service');

const pixels = (width, height, alpha = 1) => sharp({
  create: { width, height, channels: 4, background: { r: 20, g: 90, b: 210, alpha } },
});
const uploadInput = (buffer, mimetype = 'image/png') => ({ buffer, mimetype });
const expectImageError = (status, code) => (error) =>
  error.getStatus() === status && error.getResponse().code === code;

test('optional upload configuration validates without disclosing configuration values', () => {
  assert.doesNotThrow(() => validateApiConfig({ NODE_ENV: 'test' }));
  assert.doesNotThrow(() => validateApiConfig({ NODE_ENV: 'test', IMAGEKIT_URL_ENDPOINT: endpoint }));
  assert.doesNotThrow(() => validateApiConfig({ NODE_ENV: 'test', IMAGEKIT_PRIVATE_KEY: 'fixture', IMAGEKIT_URL_ENDPOINT: endpoint }));
  assert.throws(() => validateApiConfig({
    NODE_ENV: 'test', IMAGEKIT_PRIVATE_KEY: 'fixture', IMAGEKIT_URL_ENDPOINT: 'http://invalid.example/',
  }), /IMAGEKIT_URL_ENDPOINT must be an HTTPS base URL/);
});

test('normalizes EXIF orientation, strips metadata and resizes without upscaling', async () => {
  const processor = new ImageProcessingService();
  const input = await pixels(1600, 800).withMetadata({ orientation: 6 }).jpeg().toBuffer();
  assert.equal((await sharp(input).metadata()).orientation, 6);
  const output = await processor.process(uploadInput(input, 'image/jpeg'));
  const result = await sharp(output).metadata();
  assert.deepEqual([result.format, result.width, result.height], ['webp', 600, 1200]);
  for (const field of ['orientation', 'exif', 'icc', 'xmp', 'iptc']) assert.equal(result[field], undefined);
  const small = await processor.process(uploadInput(await pixels(60, 30, 0.4).png().toBuffer()));
  const transparent = await sharp(small).metadata();
  assert.deepEqual([transparent.width, transparent.height, transparent.hasAlpha], [60, 30, true]);
  const { data } = await sharp(small).raw().toBuffer({ resolveWithObject: true });
  assert.equal(data[3], 102);
});

test('rejects spoofed, damaged, animated and excessively large decoded images', async () => {
  const processor = new ImageProcessingService();
  const png = await pixels(20, 20).png().toBuffer();
  const svg = Buffer.from('<svg/>');
  await assert.rejects(processor.process(uploadInput(svg, 'image/svg+xml')), expectImageError(415, 'UNSUPPORTED_IMAGE_FORMAT'));
  await assert.rejects(processor.process(uploadInput(png, 'image/jpeg')), expectImageError(400, 'VALIDATION_ERROR'));
  const broken = png.subarray(0, Math.floor(png.length / 2));
  await assert.rejects(processor.process(uploadInput(broken)), expectImageError(400, 'VALIDATION_ERROR'));
  const jpeg = await pixels(100, 100).jpeg().toBuffer();
  await assert.rejects(processor.process(uploadInput(jpeg.subarray(0, -2), 'image/jpeg')),
    expectImageError(400, 'VALIDATION_ERROR'));

  const oversized = await pixels(4100, 4000).png().toBuffer();
  assert.ok(oversized.length <= MAX_IMAGE_BYTES);
  await assert.rejects(processor.process(uploadInput(oversized)), expectImageError(413, 'IMAGE_TOO_LARGE'));

  const frameData = Buffer.concat([Buffer.alloc(24, 40), Buffer.alloc(24, 200)]);
  const animated = await sharp(frameData, { raw: { width: 4, height: 4, channels: 3, pageHeight: 2 } })
    .webp({ delay: [100, 100] }).toBuffer();
  assert.equal((await sharp(animated).metadata()).pages, 2);
  await assert.rejects(processor.process(uploadInput(animated, 'image/webp')), expectImageError(415, 'UNSUPPORTED_IMAGE_FORMAT'));

  const control = Buffer.from('000000086163544c0000000200000000f38d9370', 'hex');
  const apng = Buffer.concat([png.subarray(0, 33), control, png.subarray(33)]);
  await assert.rejects(processor.process(uploadInput(apng)), expectImageError(415, 'UNSUPPORTED_IMAGE_FORMAT'));
  const multiPicture = Buffer.concat([jpeg.subarray(0, 2), Buffer.from('ffe200064d504600', 'hex'), jpeg.subarray(2)]);
  await assert.rejects(processor.process(uploadInput(multiPicture, 'image/jpeg')), expectImageError(415, 'UNSUPPORTED_IMAGE_FORMAT'));
});

test('bounds the size of recompressed high-detail WebP input', async () => {
  const processor = new ImageProcessingService();
  const raw = randomBytes(1200 * 1200 * 3);
  const input = await sharp(raw, { raw: { width: 1200, height: 1200, channels: 3 } }).webp({ quality: 2 }).toBuffer();
  assert.ok(input.length <= MAX_IMAGE_BYTES);
  const output = await processor.process(uploadInput(input, 'image/webp'));
  assert.ok(output.length <= MAX_IMAGE_BYTES);
  assert.equal((await sharp(output).metadata()).format, 'webp');
});

test('merchant image upload HTTP contract with a mocked ImageKit SDK', async (t) => {
  const app = await createApp({ logger: false });
  t.after(() => app.close());
  const prisma = app.get(PrismaService);
  prisma.onModuleInit = async () => {};
  const sessions = new Map();
  prisma.getClient = () => ({ userSession: { findUnique: async ({ where }) => sessions.get(where.id) } });

  const tokenFor = (verificationStatus) => {
    const id = randomUUID();
    const sid = randomUUID();
    const now = new Date();
    sessions.set(sid, {
      userId: id, lastActivityAt: now, expiresAt: new Date(now.getTime() + 3_600_000), revokedAt: null,
      user: {
        id, name: 'Upload fixture', phone: '0999100061', createdAt: now, isAdmin: false, isCustomer: true,
        isMarketer: false, customerProfile: null, merchantProfile: verificationStatus
          ? { shopName: 'Fixture shop', shopDetails: 'Fixture details', contractReference: null, verificationStatus }
          : null,
      },
    });
    return new JwtService().sign({ sub: id, sid }, { secret, algorithm: 'HS256', expiresIn: 1800 });
  };

  const media = app.get(MediaService);
  const configured = new MediaService(new ConfigService({
    IMAGEKIT_PRIVATE_KEY: 'synthetic-test-key', IMAGEKIT_URL_ENDPOINT: endpoint,
  }), app.get(ImageProcessingService));
  const stored = [];
  let resultMode;
  t.mock.method(configured.client.files, 'upload', async (request) => {
    stored.push(request);
    if (resultMode === 'throw') throw new Error('Synthetic private upstream detail.');
    if (resultMode === 'wrong-endpoint') return { url: `https://delivery.example.test/other-account/mardood/products/${request.fileName}` };
    return { url: `${endpoint}/mardood/products/${request.fileName}` };
  });

  await app.listen(0, '127.0.0.1');
  const origin = await app.getUrl();
  const url = `${origin}/api/v1/merchant/uploads/image`;
  const png = await pixels(20, 10).png().toBuffer();
  const form = (bytes = png, mime = 'image/png') => {
    const body = new FormData();
    body.append('file', new Blob([bytes], { type: mime }), 'untrusted-original.png');
    return body;
  };
  const post = (body, token = tokenFor('verified'), contentType) => fetch(url, { method: 'POST', body,
    headers: { ...(token && { authorization: `Bearer ${token}` }), ...(contentType && { 'content-type': contentType }) },
    signal: AbortSignal.timeout(5000),
  });
  async function expect(response, status, code) {
    assert.equal(response.status, status);
    const body = await response.json();
    if (code) assert.equal(body.code, code);
    return body;
  }

  await t.test('missing configuration returns a sanitized 503 and keeps Swagger available', async () => {
    await expect(await post(form()), 503, 'IMAGE_UPLOAD_UNAVAILABLE');
    const docs = await (await fetch(`${origin}/api/docs-json`)).json();
    const swagger = docs.paths['/api/v1/merchant/uploads/image'].post;
    assert.deepEqual(swagger.security, [{ bearer: [] }]);
    assert.deepEqual(swagger.requestBody.content['multipart/form-data'].schema.required, ['file']);
    assert.deepEqual(Object.keys(swagger.responses).sort(), ['201', '400', '401', '403', '413', '415', '429', '502', '503']);
  });

  t.mock.method(media, 'upload', configured.upload.bind(configured));
  await t.test('requires an authenticated, verified merchant before accepting the upload', async () => {
    await expect(await post(form(), null), 401, 'AUTH_REQUIRED');
    await expect(await post(form(), tokenFor(null)), 403, 'FORBIDDEN');
    for (const status of ['pending', 'rejected']) {
      await expect(await post(form(), tokenFor(status)), 403, 'MERCHANT_NOT_VERIFIED');
    }
    assert.equal(stored.length, 0);
  });

  await t.test('rejects missing, multiple, extra or malformed multipart parts and oversized files', async () => {
    await expect(await post(new FormData()), 400, 'VALIDATION_ERROR');
    const multiple = form();
    multiple.append('file', new Blob([png], { type: 'image/png' }), 'extra.png');
    await expect(await post(multiple), 400, 'VALIDATION_ERROR');
    const extra = form();
    extra.append('description', 'unexpected');
    await expect(await post(extra), 400, 'VALIDATION_ERROR');
    await expect(await post('broken', tokenFor('verified'), 'multipart/form-data'), 400, 'VALIDATION_ERROR');
    await expect(await post(form(new Uint8Array(MAX_IMAGE_BYTES + 1))), 413, 'IMAGE_TOO_LARGE');
    await expect(await post(form(new Uint8Array(MAX_IMAGE_BYTES - 1))), 400, 'VALIDATION_ERROR');
    await expect(await post(form(new Uint8Array(MAX_IMAGE_BYTES))), 400, 'VALIDATION_ERROR');
    await expect(await post(form(png, 'image/gif')), 415, 'UNSUPPORTED_IMAGE_FORMAT');
    assert.equal(stored.length, 0);
  });

  await t.test('uploads a public WebP with a unique name and keeps the campaign URL input compatible', async () => {
    const response = await post(form());
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const { imageUrl } = await expect(response, 201);
    const passed = stored[0];
    assert.match(passed.fileName, /^[a-f0-9-]{36}\.webp$/u);
    assert.equal(imageUrl, `${endpoint}/mardood/products/${passed.fileName}`);
    assert.deepEqual([passed.folder, passed.overwriteFile, passed.useUniqueFileName, passed.isPrivateFile],
      ['/mardood/products', false, false, false]);
    assert.equal(passed.file.type, 'image/webp');
    assert.equal((await sharp(Buffer.from(await passed.file.arrayBuffer())).metadata()).format, 'webp');
    const second = await expect(await post(form()), 201);
    assert.notEqual(second.imageUrl, imageUrl);
    for (const candidate of [imageUrl, 'https://external.example.test/campaign.jpg', 'http://images.example.test/legacy.png']) {
      const errors = await validate(plainToInstance(LaunchCampaignDto, {
        campaignType: 'product', productName: 'Uploaded product', description: 'Upload fixture', imageUrl: candidate,
        originalPriceSyp: 100000, discountPercent: 10, commission: { type: 'fixed', amountSyp: 10000 },
        maxItems: 3, joinMode: 'open', endsAt: new Date(Date.now() + 3600000).toISOString(),
      }));
      assert.deepEqual(errors, []);
    }
  });

  await t.test('redacts ImageKit failures and rejects cross-account delivery URLs', async () => {
    for (const mode of ['throw', 'wrong-endpoint']) {
      resultMode = mode;
      const body = await expect(await post(form()), 502, 'IMAGE_UPLOAD_FAILED');
      assert.deepEqual(body, { statusCode: 502, code: 'IMAGE_UPLOAD_FAILED', message: 'Unable to store the image. Try again later.' });
    }
    resultMode = undefined;
  });

  await t.test('limits attempts per authenticated merchant, independent of a shared client IP', async () => {
    const actor = tokenFor('verified');
    for (let attempt = 0; attempt < 10; attempt++) {
      await expect(await post(new FormData(), actor), 400, 'VALIDATION_ERROR');
    }
    await expect(await post(form(), actor), 429, 'RATE_LIMITED');
    await expect(await post(form(), tokenFor('verified')), 201);
  });
});
