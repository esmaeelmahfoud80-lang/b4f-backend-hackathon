import { Controller, Get, Header, ServiceUnavailableException } from '@nestjs/common';
import { ApiOkResponse, ApiServiceUnavailableResponse, ApiTags } from '@nestjs/swagger';
import { AuthErrorDto } from '../common/http/auth-error.dto';
import { PrismaService } from '../prisma/prisma.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({
    schema: {
      type: 'object',
      required: ['status'],
      properties: { status: { type: 'string', enum: ['ok'] } },
    },
  })
  @ApiServiceUnavailableResponse({ type: AuthErrorDto, description: 'DATABASE_UNAVAILABLE' })
  async getHealth(): Promise<{ status: 'ok' }> {
    try {
      await this.prisma.checkConnection();
    } catch {
      throw new ServiceUnavailableException({
        statusCode: 503,
        code: 'DATABASE_UNAVAILABLE',
        message: 'The service is temporarily unavailable.',
      });
    }
    return { status: 'ok' };
  }
}
