import { applyDecorators, Body, Controller, Get, Header, Headers, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiNoContentResponse, ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { requireRequestAuth, type RequestWithAuth } from './authenticated-actor';
import { AccountDto, AuthSessionDto } from './dto/auth-session.dto';
import { AuthErrorDto } from '../common/http/auth-error.dto';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { LoginDto } from './dto/login.dto';
import { LoginThrottlerGuard } from './login-throttler.guard';
import { RegisterDto } from './dto/register.dto';
import { LogoutDto, RefreshDto } from './dto/session-token.dto';

const ThrottleAuth = () => applyDecorators(
  UseGuards(LoginThrottlerGuard),
  ApiResponse({ status: 429, type: AuthErrorDto, description: 'RATE_LIMITED' }),
);

@ApiTags('Authentication')
@ApiResponse({ status: 400, type: AuthErrorDto, description: 'VALIDATION_ERROR' })
@ApiResponse({ status: 500, type: AuthErrorDto, description: 'INTERNAL_ERROR' })
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('register')
  @ThrottleAuth()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Register a public account and start a session' })
  @ApiBody({ type: RegisterDto })
  @ApiCreatedResponse({ type: AuthSessionDto })
  @ApiResponse({ status: 409, type: AuthErrorDto, description: 'PHONE_ALREADY_REGISTERED' })
  register(@Body() input: RegisterDto) {
    return this.auth.register(input);
  }

  @Get('me')
  @Header('Cache-Control', 'no-store')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get the current authenticated account' })
  @ApiOkResponse({ type: AccountDto })
  @ApiResponse({ status: 401, type: AuthErrorDto, description: 'AUTH_REQUIRED or SESSION_EXPIRED' })
  @ApiResponse({ status: 403, type: AuthErrorDto, description: 'FORBIDDEN under a role policy. This endpoint accepts all authenticated roles.' })
  me(@Req() request: RequestWithAuth): AccountDto {
    return requireRequestAuth(request).account;
  }

  @Post('login')
  @ThrottleAuth()
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Sign in to a public account' })
  @ApiBody({ type: LoginDto })
  @ApiOkResponse({ type: AuthSessionDto })
  @ApiResponse({ status: 401, type: AuthErrorDto, description: 'INVALID_CREDENTIALS' })
  login(@Body() input: LoginDto) {
    return this.auth.login(input, false);
  }

  @Post('admin/login')
  @ThrottleAuth()
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Sign in to an administrator account' })
  @ApiBody({ type: LoginDto })
  @ApiOkResponse({ type: AuthSessionDto })
  @ApiResponse({ status: 401, type: AuthErrorDto, description: 'INVALID_CREDENTIALS' })
  adminLogin(@Body() input: LoginDto) {
    return this.auth.login(input, true);
  }

  @Post('refresh')
  @ThrottleAuth()
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Rotate an active session’s refresh token' })
  @ApiBody({ type: RefreshDto })
  @ApiOkResponse({ type: AuthSessionDto })
  @ApiResponse({ status: 401, type: AuthErrorDto, description: 'REFRESH_TOKEN_INVALID or SESSION_EXPIRED' })
  refresh(@Body() input: RefreshDto) {
    return this.auth.refresh(input.refreshToken);
  }

  @Post('logout')
  @ThrottleAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Revoke the session identified by the access token' })
  @ApiBearerAuth()
  @ApiBody({ type: LogoutDto, required: false })
  @ApiNoContentResponse({ description: 'Session revoked or already signed out.' })
  @ApiResponse({ status: 401, type: AuthErrorDto, description: 'AUTH_REQUIRED, REFRESH_TOKEN_INVALID or SESSION_EXPIRED' })
  logout(@Headers('authorization') authorization: string | undefined, @Body() input: LogoutDto) {
    return this.auth.logout(authorization, input?.refreshToken);
  }
}
