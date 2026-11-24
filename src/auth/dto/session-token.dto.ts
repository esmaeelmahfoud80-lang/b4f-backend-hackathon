import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength, ValidateIf } from 'class-validator';

export class RefreshDto {
  @ApiProperty({ maxLength: 256 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  refreshToken!: string;
}

export class LogoutDto {
  @ApiPropertyOptional({ maxLength: 256 })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  refreshToken?: string;
}
