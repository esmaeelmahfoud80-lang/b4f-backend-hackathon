import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';

const parseQueryInteger = ({ value }: { value: unknown }) =>
  typeof value === 'string' && /^[0-9]+$/.test(value) ? Number(value) : value;
const count = { type: 'integer', minimum: 0 } as const;

export class PageQueryDto {
  @ApiPropertyOptional({ type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER, default: 1 })
  @Transform(parseQueryInteger)
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  page = 1;

  @ApiPropertyOptional({ type: 'integer', minimum: 1, maximum: 100, default: 20 })
  @Transform(parseQueryInteger)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize = 20;
}

export class PageDto {
  @ApiProperty({ ...count, minimum: 1 })
  page!: number;
  @ApiProperty({ ...count, minimum: 1, maximum: 100 })
  pageSize!: number;
  @ApiProperty(count)
  total!: number;
  @ApiProperty({ ...count, minimum: 1, nullable: true })
  previousPage!: number | null;
  @ApiProperty({ ...count, minimum: 1, nullable: true })
  nextPage!: number | null;
}
