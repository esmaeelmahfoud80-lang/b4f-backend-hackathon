import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

@Injectable()
export class LoginThrottlerGuard extends ThrottlerGuard {
  protected override async throwThrottlingException(): Promise<void> {
    throw new HttpException({
      statusCode: 429,
      code: 'RATE_LIMITED',
      message: 'Too many login attempts. Try again later.',
    }, HttpStatus.TOO_MANY_REQUESTS);
  }
}
