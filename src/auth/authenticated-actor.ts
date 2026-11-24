import { createParamDecorator, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import type { AccountDto, Role } from './dto/auth-session.dto';

export interface AuthenticatedActor {
  readonly userId: string;
  readonly sessionId: string;
  readonly roles: readonly Role[];
}

export interface RequestWithAuth {
  headers: { authorization?: string };
  auth?: { actor: AuthenticatedActor; account: AccountDto };
}

export function requireRequestAuth(request: RequestWithAuth) {
  if (!request.auth) {
    throw new UnauthorizedException({
      statusCode: 401,
      code: 'AUTH_REQUIRED',
      message: 'Valid authentication is required.',
    });
  }
  return request.auth;
}

export const CurrentActor = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedActor =>
    requireRequestAuth(context.switchToHttp().getRequest<RequestWithAuth>()).actor,
);
