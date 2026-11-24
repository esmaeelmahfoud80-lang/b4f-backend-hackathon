import 'reflect-metadata';
import { ArgumentsHost, BadRequestException, Catch, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BaseExceptionFilter, NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { ApiConfigurationError } from './prisma/database-config';
import { DatabaseUnavailableError } from './prisma/prisma.service';

@Catch(BadRequestException)
class ValidationErrorFilter extends BaseExceptionFilter<BadRequestException> {
  override catch(_error: BadRequestException, host: ArgumentsHost) {
    super.catch(new BadRequestException({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
      message: 'Invalid request payload.',
    }), host);
  }
}

export async function createApp(options: { logger?: false } = {}) {
  const app = await NestFactory.create(AppModule, { ...options, abortOnError: false });
  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new ValidationErrorFilter(app.getHttpAdapter()));
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Affiliate Marketing Platform API')
    .setVersion('1')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('api/docs', app, () =>
    SwaggerModule.createDocument(app, swaggerConfig),
  );

  return app;
}

async function bootstrap() {
  const app = await createApp();
  try {
    const config = app.get(ConfigService);
    const port = Number(config.get<string>('PORT', '3000'));
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new ApiConfigurationError('PORT must be an integer between 1 and 65535.');
    }
    app.enableShutdownHooks();
    await app.listen(port, '0.0.0.0');
  } catch (error) {
    await app.close().catch(() => {});
    throw error;
  }
}

if (require.main === module) {
  void bootstrap().catch((error: unknown) => {
    const message = error instanceof ApiConfigurationError || error instanceof DatabaseUnavailableError
      ? error.message : 'API startup failed. Check the runtime configuration and port availability.';
    console.error(message);
    process.exitCode = 1;
  });
}
