import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayNotEmpty, ArrayUnique, IsArray, IsDefined, IsIn, IsObject, IsString, Matches, MaxLength,
  ValidateIf, ValidateNested,
} from 'class-validator';
import { LoginDto } from './login.dto';

const publicRoles = ['customer', 'marketer', 'merchant'] as const;

class RegistrationShopDto {
  @ApiProperty({ minLength: 1, maxLength: 120 })
  @IsString()
  @Matches(/\S/)
  @MaxLength(120)
  name!: string;

  @ApiProperty({ minLength: 1, maxLength: 2000 })
  @IsString()
  @Matches(/\S/)
  @MaxLength(2000)
  details!: string;
}

export class RegisterDto extends LoginDto {
  @ApiProperty({ minLength: 1, maxLength: 120 })
  @IsString()
  @Matches(/\S/)
  @MaxLength(120)
  name!: string;

  @ApiProperty({ enum: publicRoles, isArray: true, minItems: 1, uniqueItems: true })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @IsIn(publicRoles, { each: true })
  roles!: (typeof publicRoles)[number][];

  @ApiPropertyOptional({ type: RegistrationShopDto, description: 'Required when roles includes merchant.' })
  @ValidateIf((input: RegisterDto) => input.shop !== undefined ||
    (Array.isArray(input.roles) && input.roles.includes('merchant')))
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => RegistrationShopDto)
  shop?: RegistrationShopDto;
}
