import { HttpException } from '@nestjs/common';

const errors = {
  VALIDATION_ERROR: [400, 'Submit exactly one valid, static image in the file field.'],
  IMAGE_TOO_LARGE: [413, 'The image exceeds the supported size or decoded pixel limit.'],
  UNSUPPORTED_IMAGE_FORMAT: [415, 'Only static JPEG, PNG and WebP images are supported.'],
  IMAGE_UPLOAD_FAILED: [502, 'Unable to store the image. Try again later.'],
  IMAGE_UPLOAD_UNAVAILABLE: [503, 'Image uploads are currently unavailable.'],
} as const;

export function mediaError(code: keyof typeof errors): HttpException {
  const [statusCode, message] = errors[code];
  return new HttpException({ statusCode, code, message }, statusCode);
}
