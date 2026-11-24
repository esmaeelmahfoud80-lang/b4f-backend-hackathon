import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool, type PoolClient } from 'pg';
import { PrismaClient } from '../generated/prisma/client';

const readinessTimeoutMs = 2_500;

export class DatabaseUnavailableError extends Error {
  constructor() {
    super('PostgreSQL is unavailable. Check DATABASE_URL and database connectivity.');
  }
}

@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly pool?: Pool;
  private readonly client?: PrismaClient;
  private probe?: Promise<void>;

  constructor(config: ConfigService) {
    const connectionString = config.get<string>('DATABASE_URL');
    if (connectionString) {
      this.pool = new Pool({ connectionString, connectionTimeoutMillis: 5000 });
      const adapter = new PrismaPg(this.pool, { disposeExternalPool: true });
      this.client = new PrismaClient({ adapter });
    }
  }

  async onModuleInit() {
    if (!this.client) return;
    try {
      await this.client.$connect();
      await this.checkConnection();
    } catch {
      await this.client.$disconnect().catch(() => {});
      throw new DatabaseUnavailableError();
    }
  }

  async onModuleDestroy() {
    await this.client?.$disconnect();
  }

  getClient(): PrismaClient {
    if (!this.client) {
      throw new Error('Database connection is not configured.');
    }
    return this.client;
  }

  checkConnection(): Promise<void> {
    if (!this.pool) return Promise.reject(new DatabaseUnavailableError());
    this.probe ??= this.probePool(this.pool).finally(() => { this.probe = undefined; });
    return this.probe;
  }

  private async probePool(pool: Pool): Promise<void> {
    let client: PoolClient | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let done = false;
    let healthy = false;
    try {
      const expiry = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new DatabaseUnavailableError()), readinessTimeoutMs);
      });
      const query = async () => {
        const connection = await pool.connect();
        if (done) {
          connection.release();
          return;
        }
        client = connection;
        const { rows } = await connection.query<{ result: number }>('SELECT 1 AS result');
        if (rows[0]?.result !== 1) throw new DatabaseUnavailableError();
      };
      await Promise.race([query(), expiry]);
      healthy = true;
    } catch {
      throw new DatabaseUnavailableError();
    } finally {
      done = true;
      clearTimeout(timeout);
      // A timed-out query can still be outstanding. Discard that connection before reuse.
      client?.release(!healthy);
    }
  }
}
