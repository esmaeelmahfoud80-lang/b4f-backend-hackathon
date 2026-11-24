import { ConflictException, HttpException, Injectable, InternalServerErrorException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { validateIdempotencyKey } from './idempotency-key';
import { canonicalJson, requestFingerprint } from './request-fingerprint';

interface IdempotencyRequest {
  actorId: string;
  operation: string;
  key: string;
  payload: unknown;
}

export interface IdempotentResponse<T> {
  statusCode: number;
  body: T;
}

@Injectable()
export class IdempotencyService {
  constructor(private readonly prisma: PrismaService) {}

  async execute<T>(
    request: IdempotencyRequest,
    work: (tx: Prisma.TransactionClient) => Promise<IdempotentResponse<T>>,
  ): Promise<IdempotentResponse<T>> {
    const scope = {
      actorId: request.actorId,
      operation: request.operation,
      requestKey: validateIdempotencyKey(request.key),
    };
    const where = { actorId_operation_requestKey: scope };

    try {
      const fingerprint = requestFingerprint(request.payload);
      return await this.prisma.getClient().$transaction(async (tx) => {
        // ON CONFLICT DO NOTHING waits for the owning transaction without aborting this one.
        const claim = await tx.idempotencyRecord.createMany({
          data: { ...scope, requestFingerprint: fingerprint, responseStatus: 0, responseBody: Prisma.JsonNull },
          skipDuplicates: true,
        });

        if (claim.count === 0) {
          // At READ COMMITTED, this statement sees the winner's committed response.
          const existing = await tx.idempotencyRecord.findUniqueOrThrow({ where });
          if (existing.requestFingerprint !== fingerprint) {
            throw new ConflictException({
              statusCode: 409,
              code: 'IDEMPOTENCY_KEY_REUSED',
              message: 'This Idempotency-Key was already used with a different request.',
            });
          }
          if (existing.responseStatus < 200 || existing.responseStatus >= 300) {
            throw new Error('No committed idempotent response.');
          }
          return { statusCode: existing.responseStatus, body: existing.responseBody as T };
        }

        const result = await work(tx);
        if (!Number.isInteger(result.statusCode) || result.statusCode < 200 || result.statusCode >= 300) {
          throw new Error('The idempotent callback must return a successful HTTP status.');
        }
        const body = JSON.parse(canonicalJson(result.body)) as Prisma.JsonValue;
        await tx.idempotencyRecord.update({
          where,
          data: { responseStatus: result.statusCode, responseBody: body === null ? Prisma.JsonNull : body },
        });
        return { statusCode: result.statusCode, body: body as T };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new InternalServerErrorException({
        statusCode: 500,
        code: 'INTERNAL_ERROR',
        message: 'Unable to complete the operation.',
      });
    }
  }
}
