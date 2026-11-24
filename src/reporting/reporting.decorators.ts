import { applyDecorators, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import type { Role } from '../auth/dto/auth-session.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { AuthErrorDto } from '../common/http/auth-error.dto';

export const ReportingAccess = (role: Role) => applyDecorators(
  UseGuards(JwtAuthGuard, RolesGuard),
  Roles(role),
  ApiBearerAuth(),
  ApiResponse({ status: 401, type: AuthErrorDto, description: 'AUTH_REQUIRED or SESSION_EXPIRED' }),
  ApiResponse({ status: 403, type: AuthErrorDto, description: 'FORBIDDEN' }),
  ApiResponse({ status: 409, type: AuthErrorDto, description: 'AMOUNT_OUT_OF_RANGE' }),
  ApiResponse({ status: 500, type: AuthErrorDto, description: 'INTERNAL_ERROR' }),
);

export const PageValidation = () => ApiResponse({ status: 400, type: AuthErrorDto, description: 'VALIDATION_ERROR' });
