import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import ImageKit, { toFile } from '@imagekit/nodejs';
import { readImageKitConfig } from '../config/imagekit-config';
import { ImageProcessingService, type ImageUpload } from './image-processing.service';
import { mediaError } from './media-errors';

const folder = '/mardood/products';

@Injectable()
export class MediaService {
  private readonly settings: ReturnType<typeof readImageKitConfig>;
  private readonly client?: ImageKit;

  constructor(config: ConfigService, private readonly images: ImageProcessingService) {
    this.settings = readImageKitConfig(config.get('IMAGEKIT_PRIVATE_KEY'), config.get('IMAGEKIT_URL_ENDPOINT'));
    if (this.settings) {
      this.client = new ImageKit({ privateKey: this.settings.privateKey, timeout: 8000, maxRetries: 0 });
    }
  }

  async upload(file?: ImageUpload): Promise<{ imageUrl: string }> {
    if (!this.client || !this.settings) throw mediaError('IMAGE_UPLOAD_UNAVAILABLE');
    const image = await this.images.process(file);
    const fileName = `${randomUUID()}.webp`;
    try {
      const uploaded = await this.client.files.upload({
        file: await toFile(image, fileName, { type: 'image/webp' }), fileName, folder,
        isPrivateFile: false, useUniqueFileName: false, overwriteFile: false,
      });
      const imageUrl = uploaded.url;
      if (typeof imageUrl !== 'string') throw new Error('Missing ImageKit delivery URL.');
      const url = URL.parse(imageUrl);
      if (!url || url.origin !== this.settings.origin || url.username || url.password || url.search || url.hash ||
          url.pathname !== `${this.settings.basePath}${folder}/${fileName}`) {
        throw new Error('Unexpected ImageKit delivery URL.');
      }
      return { imageUrl };
    } catch {
      throw mediaError('IMAGE_UPLOAD_FAILED');
    }
  }
}
