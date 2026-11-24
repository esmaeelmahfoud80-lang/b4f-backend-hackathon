import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { requireRequestAuth, type RequestWithAuth } from './authenticated-actor';
import type { Role } from './dto/auth-session.dto';

const RequiredRoles = Reflector.createDecorator<readonly Role[]>();
export const Roles = (...roles: Role[]) => RequiredRoles(roles);

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const { actor } = requireRequestAuth(context.switchToHttp().getRequest<RequestWithAuth>());
    const roles = this.reflector.getAllAndOverride(RequiredRoles, [context.getHandler(), context.getClass()]);
    if (roles?.length && !roles.some((role) => actor.roles.includes(role))) {
      throw new ForbiddenException({
        statusCode: 403,
        code: 'FORBIDDEN',
        message: 'You do not have permission to perform this action.',
      });
    }
    return true;
  }
}
