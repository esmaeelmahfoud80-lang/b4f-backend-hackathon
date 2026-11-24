import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { ConflictException, Injectable, InternalServerErrorException, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { toMoneyJsonInteger } from '../common/money';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { RequestWithAuth } from './authenticated-actor';
import { accountRoles } from './account-roles';
import { ACCESS_TOKEN_SECONDS, AccountDto, AuthSessionDto } from './dto/auth-session.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';

const SESSION_INACTIVITY_MS = 30 * 24 * 60 * 60 * 1000;
const BCRYPT_HASH = /^\$2[ab]\$\d{2}\$[./A-Za-z0-9]{53}$/;
const accountRelations = { merchantProfile: true, customerProfile: true } as const;
type AccountRecord = Prisma.UserGetPayload<{ include: typeof accountRelations; omit: { passwordHash: true } }>;
type SessionTimes = { expiresAt: Date; lastActivityAt: Date };
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function hashRefreshToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

function unauthorized(code: 'AUTH_REQUIRED' | 'REFRESH_TOKEN_INVALID' | 'SESSION_EXPIRED') {
  const messages = {
    AUTH_REQUIRED: 'Valid authentication is required.',
    REFRESH_TOKEN_INVALID: 'Invalid refresh token.',
    SESSION_EXPIRED: 'Session expired.',
  };
  return new UnauthorizedException({ statusCode: 401, code, message: messages[code] });
}

function activeSessionWhere(now: Date): Prisma.UserSessionWhereInput {
  return {
    revokedAt: null,
    expiresAt: { gt: now },
    lastActivityAt: { gt: new Date(now.getTime() - SESSION_INACTIVITY_MS) },
  };
}

function isExpired(session: SessionTimes, now: Date) {
  return session.expiresAt <= now || session.lastActivityAt.getTime() <= now.getTime() - SESSION_INACTIVITY_MS;
}

function authFailure(error: unknown, message: string): never {
  if (error instanceof UnauthorizedException) throw error;
  throw new InternalServerErrorException({ statusCode: 500, code: 'INTERNAL_ERROR', message });
}

function mapAccount(record: AccountRecord): AccountDto {
  const merchant = record.merchantProfile;
  const customer = record.customerProfile;
  return {
    id: record.id,
    name: record.name,
    phone: record.phone,
    roles: accountRoles(record),
    createdAt: record.createdAt.toISOString(),
    merchant: merchant ? {
      name: merchant.shopName,
      details: merchant.shopDetails,
      verificationStatus: merchant.verificationStatus,
      contractReference: merchant.contractReference,
    } : null,
    customer: customer ? {
      verifiedPurchaseCount: customer.verifiedPurchaseCount,
      availableCashbackSyp: toMoneyJsonInteger(customer.availableCashbackSyp),
      lockedCashbackSyp: toMoneyJsonInteger(customer.lockedCashbackSyp),
    } : null,
  };
}

@Injectable()
export class AuthService implements OnModuleInit {
  private dummyHash!: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly jwt: JwtService,
  ) {}

  async onModuleInit() {
    this.dummyHash = await bcrypt.hash(randomBytes(32), 10);
  }

  async authenticate(authorization?: string): Promise<NonNullable<RequestWithAuth['auth']>> {
    try {
      const { sub, sid } = await this.verifyAccessToken(authorization);
      const session = await this.prisma.getClient().userSession.findUnique({
        where: { id: sid },
        select: {
          userId: true,
          lastActivityAt: true,
          expiresAt: true,
          revokedAt: true,
          user: { include: accountRelations, omit: { passwordHash: true } },
        },
      });
      if (!session || session.userId !== sub || !session.user) throw unauthorized('AUTH_REQUIRED');
      if (session.revokedAt || isExpired(session, new Date())) throw unauthorized('SESSION_EXPIRED');

      // Auth checks and polling are read-only. Future intentional user actions should
      // update lastActivityAt in their service transaction without extending expiresAt.
      const account = mapAccount(session.user);
      return { actor: { userId: sub, sessionId: sid, roles: account.roles }, account };
    } catch (error) {
      return authFailure(error, 'Unable to verify the session.');
    }
  }

  async login(input: LoginDto, adminLogin: boolean): Promise<AuthSessionDto> {
    try {
      const client = this.prisma.getClient();
      const account = await client.user.findUnique({
        where: { phone: input.phone },
        include: accountRelations,
      });
      const hash = account?.passwordHash;
      const supportedHash = hash && BCRYPT_HASH.test(hash) ? hash : undefined;
      const match = await bcrypt.compare(input.password, supportedHash ?? this.dummyHash);
      if (!account || !supportedHash || !match || account.isAdmin !== adminLogin) {
        throw new UnauthorizedException({
          statusCode: 401,
          code: 'INVALID_CREDENTIALS',
          message: 'Invalid phone number or password.',
        });
      }

      return await this.createSession(client, account);
    } catch (error) {
      return authFailure(error, 'Unable to sign in.');
    }
  }

  async register(input: RegisterDto): Promise<AuthSessionDto> {
    try {
      const passwordHash = await bcrypt.hash(input.password, 10);
      const isCustomer = input.roles.includes('customer');
      const shop = input.roles.includes('merchant') ? input.shop : undefined;
      const wallets = input.roles.filter((role) => role !== 'customer').map((role) => ({ role }));

      return await this.prisma.getClient().$transaction(async (tx) => {
        const account = await tx.user.create({
          data: {
            name: input.name,
            phone: input.phone,
            passwordHash,
            isCustomer,
            isMarketer: input.roles.includes('marketer'),
            customerProfile: isCustomer ? { create: {} } : undefined,
            merchantProfile: shop ? { create: { shopName: shop.name, shopDetails: shop.details } } : undefined,
            wallets: wallets.length ? { create: wallets } : undefined,
          },
          include: accountRelations,
          omit: { passwordHash: true },
        });
        return this.createSession(tx, account);
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const adapterError = error.meta?.driverAdapterError as {
          cause?: { constraint?: { index?: string; fields?: string[] } };
        } | undefined;
        const constraint = adapterError?.cause?.constraint;
        const target = constraint?.index ?? constraint?.fields ?? error.meta?.target;
        if (target === 'users_phone_key' || (Array.isArray(target) && target.length === 1 && target[0] === 'phone')) {
          throw new ConflictException({
            statusCode: 409,
            code: 'PHONE_ALREADY_REGISTERED',
            message: 'This phone number is already registered.',
          });
        }
      }
      return authFailure(error, 'Unable to register the account.');
    }
  }

  async refresh(refreshToken: string): Promise<AuthSessionDto> {
    try {
      const oldHash = hashRefreshToken(refreshToken);
      return await this.prisma.getClient().$transaction(async (tx) => {
        const session = await tx.userSession.findUnique({
          where: { refreshTokenHash: oldHash },
          include: { user: { include: accountRelations } },
        });
        if (!session || session.revokedAt) throw unauthorized('REFRESH_TOKEN_INVALID');
        if (isExpired(session, new Date())) throw unauthorized('SESSION_EXPIRED');

        const response = await this.issueSession(session.user, session.id);
        const now = new Date();
        const updated = await tx.userSession.updateMany({
          where: { id: session.id, refreshTokenHash: oldHash, ...activeSessionWhere(now) },
          data: { refreshTokenHash: hashRefreshToken(response.refreshToken) },
        });
        if (updated.count !== 1) {
          if (isExpired(session, now)) throw unauthorized('SESSION_EXPIRED');
          throw unauthorized('REFRESH_TOKEN_INVALID');
        }
        return response;
      });
    } catch (error) {
      return authFailure(error, 'Unable to refresh the session.');
    }
  }

  async logout(authorization?: string, refreshToken?: string): Promise<void> {
    try {
      const { sub, sid } = await this.verifyAccessToken(authorization);
      const refreshTokenHash = refreshToken === undefined ? undefined : hashRefreshToken(refreshToken);
      await this.prisma.getClient().$transaction(async (tx) => {
        const readSession = () => tx.userSession.findUnique({ where: { id: sid } });
        const checkSession = (session: Awaited<ReturnType<typeof readSession>>, now: Date) => {
          if (!session || session.userId !== sub) throw unauthorized('AUTH_REQUIRED');
          if (refreshTokenHash !== undefined && session.refreshTokenHash !== refreshTokenHash) {
            throw unauthorized('REFRESH_TOKEN_INVALID');
          }
          if (!session.revokedAt && isExpired(session, now)) throw unauthorized('SESSION_EXPIRED');
          return session;
        };

        const session = checkSession(await readSession(), new Date());
        if (session.revokedAt) return;

        const now = new Date();
        const updated = await tx.userSession.updateMany({
          where: {
            id: sid,
            userId: sub,
            ...activeSessionWhere(now),
            ...(refreshTokenHash === undefined ? {} : { refreshTokenHash }),
          },
          data: { revokedAt: now },
        });
        if (updated.count === 0 && !checkSession(await readSession(), new Date()).revokedAt) {
          throw unauthorized('AUTH_REQUIRED');
        }
      });
    } catch (error) {
      return authFailure(error, 'Unable to sign out.');
    }
  }

  private async createSession(client: Prisma.TransactionClient, account: AccountRecord): Promise<AuthSessionDto> {
    const sessionId = randomUUID();
    const now = new Date();
    const response = await this.issueSession(account, sessionId);
    await client.userSession.create({
      data: {
        id: sessionId,
        userId: account.id,
        refreshTokenHash: hashRefreshToken(response.refreshToken),
        lastActivityAt: now,
        expiresAt: new Date(now.getTime() + SESSION_INACTIVITY_MS),
        createdAt: now,
      },
      select: { id: true },
    });
    return response;
  }

  private async issueSession(account: AccountRecord, sessionId: string): Promise<AuthSessionDto> {
    const user = mapAccount(account);
    const accessToken = await this.jwt.signAsync(
      { sub: user.id, sid: sessionId, roles: user.roles },
      { secret: this.jwtSecret(), algorithm: 'HS256', expiresIn: ACCESS_TOKEN_SECONDS, jwtid: randomUUID() },
    );
    return {
      accessToken,
      expiresInSeconds: ACCESS_TOKEN_SECONDS,
      refreshToken: randomBytes(32).toString('base64url'),
      user,
    };
  }

  private async verifyAccessToken(authorization?: string): Promise<{ sub: string; sid: string }> {
    const token = authorization?.match(/^Bearer ([\w-]+\.[\w-]+\.[\w-]+)$/i)?.[1];
    if (!token) throw unauthorized('AUTH_REQUIRED');
    const secret = this.jwtSecret();
    const claims = await this.jwt.verifyAsync<{ sub?: unknown; sid?: unknown; exp?: unknown }>(
      token, { secret, algorithms: ['HS256'] },
    ).catch(() => { throw unauthorized('AUTH_REQUIRED'); });
    const { sub, sid, exp } = claims;
    if (typeof sub !== 'string' || !UUID.test(sub) ||
      typeof sid !== 'string' || !UUID.test(sid) || typeof exp !== 'number') {
      throw unauthorized('AUTH_REQUIRED');
    }
    return { sub, sid };
  }

  private jwtSecret(): string {
    const secret = this.config.get<string>('JWT_SECRET');
    if (!secret || Buffer.byteLength(secret.trim(), 'utf8') < 32) {
      throw new Error('JWT signing secret is missing or too short.');
    }
    return secret;
  }
}
