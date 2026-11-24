import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { PrismaService } from './prisma.service';

async function checkConnection() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    abortOnError: false,
    logger: false,
  });

  try {
    if (!app.get(ConfigService).get<string>('DATABASE_URL')) {
      console.error('PostgreSQL connection unverified. Set DATABASE_URL and rerun the check.');
      process.exitCode = 1;
      return;
    }

    await app.get(PrismaService).checkConnection();
    console.log('PostgreSQL connection verified with Prisma (SELECT 1).');
  } finally {
    await app.close();
  }
}

void checkConnection().catch(() => {
  console.error('PostgreSQL check failed. Verify DATABASE_URL and that PostgreSQL is reachable.');
  process.exitCode = 1;
});
