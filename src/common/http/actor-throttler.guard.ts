import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { RequestWithAuth } from '../../auth/authenticated-actor';

@Injectable()
export class ActorThrottlerGuard extends ThrottlerGuard {
  protected override getTracker(request: RequestWithAuth): Promise<string> {
    const actor = request.auth?.actor;
    return actor ? Promise.resolve(actor.userId) : super.getTracker(request);
  }

  protected override async throwThrottlingException(): Promise<void> {
    throw new HttpException({ statusCode: 429, code: 'RATE_LIMITED', message: 'Too many requests. Try again later.' }, HttpStatus.TOO_MANY_REQUESTS);
  }
}
