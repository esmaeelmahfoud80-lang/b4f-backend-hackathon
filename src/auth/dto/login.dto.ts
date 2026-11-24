import { ApiProperty } from '@nestjs/swagger';
import { IsByteLength, IsNotEmpty, IsString, Matches } from 'class-validator';

export class LoginDto {
  @ApiProperty({ pattern: '^09[0-9]{8}$' })
  @IsString()
  @Matches(/^09[0-9]{8}$/)
  phone!: string;

  @ApiProperty({ format: 'password', minLength: 1, maxLength: 72, description: 'At most 72 UTF-8 bytes.' })
  @IsString()
  @IsNotEmpty()
  @IsByteLength(1, 72)
  password!: string;
}
