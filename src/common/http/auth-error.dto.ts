import { ApiProperty } from '@nestjs/swagger';

export class AuthErrorDto {
  @ApiProperty({ type: 'integer' })
  statusCode!: number;

  @ApiProperty()
  code!: string;

  @ApiProperty()
  message!: string;
}
