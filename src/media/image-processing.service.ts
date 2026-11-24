import { HttpException, Injectable } from '@nestjs/common';
import sharp from 'sharp';
import { mediaError } from './media-errors';

export const MAX_IMAGE_BYTES = 500_000;
const MAX_IMAGE_PIXELS = 16_000_000;
const formats = { 'image/jpeg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp' } as const;
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const attempts = [[1200, 80], [1200, 65], [1200, 50], [900, 65]] as const;

export interface ImageUpload {
  buffer: Buffer;
  mimetype: string;
}

function isAnimatedPng(input: Buffer): boolean {
  if (!input.subarray(0, 8).equals(pngSignature)) return false;
  // libvips may expose just the default APNG frame. Inspect the PNG chunk headers.
  for (let offset = 8; offset + 12 <= input.length;) {
    const length = input.readUInt32BE(offset);
    if (length > input.length - offset - 12) return false;
    if (input.toString('ascii', offset + 4, offset + 8) === 'acTL') return true;
    offset += length + 12;
  }
  return false;
}

function isMultiPictureJpeg(input: Buffer): boolean {
  if (input[0] !== 0xff || input[1] !== 0xd8) return false;
  // Multi-picture JPEG stores its image index in an APP2 segment before the scan.
  let offset = 2;
  while (offset + 4 <= input.length && input[offset] === 0xff) {
    const marker = input[++offset];
    if (marker === 0xff) continue;
    if (marker === 0xda || marker === 0xd9) break;
    const length = input.readUInt16BE(++offset);
    if (length < 2 || offset + length > input.length) break;
    if (marker === 0xe2 && length >= 6 && input.toString('latin1', offset + 2, offset + 6) === 'MPF\0') return true;
    offset += length;
  }
  return false;
}

function isAnimatedWebp(input: Buffer): boolean {
  return input.length >= 30 && input.toString('ascii', 0, 4) === 'RIFF' &&
    input.toString('ascii', 8, 16) === 'WEBPVP8X' && (input[20] & 0x02) !== 0;
}

@Injectable()
export class ImageProcessingService {
  async process(file?: ImageUpload): Promise<Buffer> {
    if (!file?.buffer.length) throw mediaError('VALIDATION_ERROR');
    if (file.buffer.length > MAX_IMAGE_BYTES) throw mediaError('IMAGE_TOO_LARGE');
    if (!Object.hasOwn(formats, file.mimetype)) throw mediaError('UNSUPPORTED_IMAGE_FORMAT');

    const expected = formats[file.mimetype as keyof typeof formats];
    const input = file.buffer;
    // Reject SVG, GIF and other unsupported decoders before passing bytes to sharp.
    const signature = input[0] === 0xff && input[1] === 0xd8 ? 'jpeg'
      : input.subarray(0, 8).equals(pngSignature) ? 'png'
      : input.toString('ascii', 0, 4) === 'RIFF' && input.toString('ascii', 8, 12) === 'WEBP' ? 'webp'
      : undefined;
    if (signature !== expected) throw mediaError('VALIDATION_ERROR');
    if (isAnimatedPng(input) || isAnimatedWebp(input) || isMultiPictureJpeg(input)) {
      throw mediaError('UNSUPPORTED_IMAGE_FORMAT');
    }

    try {
      const decoder = sharp(input, { failOn: 'warning', limitInputPixels: MAX_IMAGE_PIXELS });
      const metadata = await decoder.metadata();
      if (metadata.format !== expected || !metadata.width || !metadata.height) throw mediaError('VALIDATION_ERROR');
      if ((metadata.pages ?? 1) > 1) throw mediaError('UNSUPPORTED_IMAGE_FORMAT');
      if (metadata.width * metadata.height > MAX_IMAGE_PIXELS) throw mediaError('IMAGE_TOO_LARGE');

      // Decode once, then re-encode the bounded, normalized pixel buffer without source metadata.
      const { data, info } = await decoder.autoOrient().resize(1200, 1200, {
        fit: 'inside', withoutEnlargement: true, fastShrinkOnLoad: false,
      }).toColourspace('srgb').raw().timeout({ seconds: 5 }).toBuffer({ resolveWithObject: true });
      for (const [dimension, quality] of attempts) {
        const output = await sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } })
          .resize(dimension, dimension, { fit: 'inside', withoutEnlargement: true })
          .webp({ quality }).timeout({ seconds: 5 }).toBuffer();
        if (output.length <= MAX_IMAGE_BYTES) return output;
      }
      throw mediaError('IMAGE_TOO_LARGE');
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (error instanceof Error && error.message === 'Input image exceeds pixel limit') throw mediaError('IMAGE_TOO_LARGE');
      throw mediaError('VALIDATION_ERROR');
    }
  }
}
