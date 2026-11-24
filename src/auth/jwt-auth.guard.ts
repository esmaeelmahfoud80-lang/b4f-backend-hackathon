import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { RequestWithAuth } from './authenticated-actor';
import { AuthService } from './auth.service';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithAuth>();
    request.auth = await this.auth.authenticate(request.headers.authorization);
    return true;
  }
}
