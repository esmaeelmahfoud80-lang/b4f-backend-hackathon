import { ApiConfigurationError, validateDatabaseConfig } from '../prisma/database-config';
import { parseCashbackThresholds } from './cashback-thresholds';
import { readImageKitConfig } from './imagekit-config';

export function validateApiConfig(config: Record<string, unknown>) {
  validateDatabaseConfig(config);
  parseCashbackThresholds(config.CASHBACK_MILESTONE_PURCHASES, config.CASHBACK_MILESTONE_SPEND_SYP);
  readImageKitConfig(config.IMAGEKIT_PRIVATE_KEY, config.IMAGEKIT_URL_ENDPOINT);
  if (config.NODE_ENV !== 'production') return config;

  const secret = config.JWT_SECRET;
  if (typeof secret !== 'string' || Buffer.byteLength(secret.trim(), 'utf8') < 32) {
    throw new ApiConfigurationError('JWT_SECRET must be set to at least 32 bytes in production.');
  }

  const web = typeof config.WEB_BASE_URL === 'string' ? URL.parse(config.WEB_BASE_URL) : null;
  if (!web || web.protocol !== 'https:' || web.username || web.password || web.pathname !== '/' || web.search || web.hash) {
    throw new ApiConfigurationError('WEB_BASE_URL must be a public HTTPS origin in production.');
  }
  return config;
}
