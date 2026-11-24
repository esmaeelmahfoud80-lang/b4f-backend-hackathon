import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { PickType } from '@nestjs/swagger';
import * as bcrypt from 'bcrypt';
import { validateSync } from 'class-validator';
import { RegisterDto } from '../auth/dto/register.dto';
import { Prisma, type PrismaClient } from '../generated/prisma/client';
import { validateDatabaseConfig } from '../prisma/database-config';
import { PrismaService } from '../prisma/prisma.service';

const developmentDatabase = 'affiliate_marketing_dev';
const bcryptRounds = 10;
const minimumPasswordLength = 12;

class BootstrapCredentials extends PickType(RegisterDto, ['name', 'phone', 'password'] as const) {}
class BootstrapConfigError extends Error {}

export function readBootstrapConfig(env: NodeJS.ProcessEnv) {
  const values = {
    name: env.BOOTSTRAP_ADMIN_NAME,
    phone: env.BOOTSTRAP_ADMIN_PHONE,
    password: env.BOOTSTRAP_ADMIN_PASSWORD,
    databaseUrl: env.DATABASE_URL,
  };
  const { name, phone, password, databaseUrl } = values;
  if (!name || !phone || !password || !databaseUrl) {
    throw new BootstrapConfigError('Set BOOTSTRAP_ADMIN_NAME, BOOTSTRAP_ADMIN_PHONE, BOOTSTRAP_ADMIN_PASSWORD and DATABASE_URL.');
  }

  const credentials = Object.assign(new BootstrapCredentials(), { name, phone, password });
  const errors = validateSync(credentials, { validationError: { target: false, value: false } });
  if (errors.length) {
    throw new BootstrapConfigError('Use a nonblank name of up to 120 characters, a Syrian mobile number (09 plus eight digits), and a password of at most 72 UTF-8 bytes.');
  }
  if ([...password.trim()].length < minimumPasswordLength) {
    throw new BootstrapConfigError('Use a bootstrap password with at least 12 characters excluding surrounding whitespace.');
  }

  let databaseName: string;
  try {
    validateDatabaseConfig({ DATABASE_URL: databaseUrl });
    databaseName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
  } catch {
    throw new BootstrapConfigError('DATABASE_URL must be a valid PostgreSQL URL with an explicit database name.');
  }
  if (databaseName === developmentDatabase) {
    throw new BootstrapConfigError('Admin bootstrap is disabled for the local development database.');
  }
  return { name, phone, password, databaseUrl, databaseName };
}

type BootstrapConfig = ReturnType<typeof readBootstrapConfig>;
type BootstrapResult = 'created' | 'admin_exists' | 'phone_exists';

export async function bootstrapAdmin(client: PrismaClient, config: BootstrapConfig): Promise<BootstrapResult> {
  const { name, phone, password, databaseName } = config;
  const passwordHash = await bcrypt.hash(password, bcryptRounds);

  return client.$transaction(async (tx) => {
    const [identity] = await tx.$queryRaw<{ databaseName: string }[]>`
      SELECT current_database() AS "databaseName"
    `;
    if (identity?.databaseName !== databaseName || identity.databaseName === developmentDatabase) {
      throw new Error('Unexpected database identity.');
    }
    // Every bootstrap attempt takes the same transaction-scoped lock before reading admin state.
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(7101, 13)`;
    if (await tx.user.findFirst({ where: { isAdmin: true }, select: { id: true } })) return 'admin_exists';

    // The unique phone constraint also handles a public registration racing this insert.
    const { count } = await tx.user.createMany({
      data: { name, phone, passwordHash, isAdmin: true },
      skipDuplicates: true,
    });
    if (count === 1) return 'created';
    if (await tx.user.findUnique({ where: { phone }, select: { id: true } })) return 'phone_exists';
    throw new Error('Unexpected user uniqueness conflict.');
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}

async function main(): Promise<number> {
  let config: BootstrapConfig;
  try {
    config = readBootstrapConfig(process.env);
  } catch (error) {
    if (!(error instanceof BootstrapConfigError)) throw error;
    console.error(error.message);
    return 2;
  }

  const database = new PrismaService(new ConfigService({ DATABASE_URL: config.databaseUrl }));
  let result: BootstrapResult;
  try {
    await database.onModuleInit();
    result = await bootstrapAdmin(database.getClient(), config);
  } finally {
    await database.onModuleDestroy();
  }

  if (result === 'phone_exists') {
    console.error('The supplied phone is already registered. No account was changed.');
    return 3;
  }
  console.log(result === 'created' ? 'Initial administrator created.' : 'An administrator already exists. No account was changed.');
  return 0;
}

if (require.main === module) {
  void main().then((code) => { process.exitCode = code; }).catch(() => {
    console.error('Admin bootstrap failed. Verify the target database, migration status and database permissions, then retry.');
    process.exitCode = 1;
  });
}
