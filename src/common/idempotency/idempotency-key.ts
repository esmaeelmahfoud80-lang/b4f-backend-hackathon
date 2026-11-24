import { BadRequestException, createParamDecorator, ExecutionContext } from '@nestjs/common';
import { isUUID } from 'class-validator';

export function validateIdempotencyKey(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 36 || !isUUID(value)) {
    throw new BadRequestException({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
      message: 'Idempotency-Key must be a UUID.',
    });
  }
  return value.toLowerCase();
}

export const IdempotencyKey = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string =>
    validateIdempotencyKey(context.switchToHttp().getRequest<{
      headers: { 'idempotency-key'?: string | string[] };
    }>().headers['idempotency-key']),
);
