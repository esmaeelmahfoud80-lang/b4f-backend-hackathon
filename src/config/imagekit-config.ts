import { ApiConfigurationError } from '../prisma/database-config';

export function readImageKitConfig(privateKeyValue: unknown, endpointValue: unknown) {
  const privateKey = typeof privateKeyValue === 'string' ? privateKeyValue.trim() : '';
  const endpoint = typeof endpointValue === 'string' ? endpointValue.trim() : '';
  if (!privateKey || !endpoint) return undefined;

  const url = URL.parse(endpoint);
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new ApiConfigurationError('IMAGEKIT_URL_ENDPOINT must be an HTTPS base URL without credentials, query or fragment.');
  }
  if (/\s/u.test(privateKey)) {
    throw new ApiConfigurationError('IMAGEKIT_PRIVATE_KEY must not contain whitespace.');
  }
  return { privateKey, origin: url.origin, basePath: url.pathname.replace(/\/+$/u, '') };
}
