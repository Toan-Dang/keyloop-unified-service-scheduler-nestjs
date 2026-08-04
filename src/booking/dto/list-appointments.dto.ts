import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsISO8601, IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../../common/pagination/keyset';

export class ListAppointmentsQueryDto {
  @ApiPropertyOptional({
    description: 'Only appointments starting at or after this instant (UTC).',
    format: 'date-time',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  from?: string;

  @ApiPropertyOptional({
    description: 'Only appointments starting strictly before this instant (UTC).',
    format: 'date-time',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  to?: string;

  @ApiPropertyOptional({ enum: ['CONFIRMED', 'CANCELLED'] })
  @IsOptional()
  @IsIn(['CONFIRMED', 'CANCELLED'])
  status?: 'CONFIRMED' | 'CANCELLED';

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  technicianId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Filter by customer. A CUSTOMER-role caller is restricted to their own rows regardless ' +
      'of this value (§14 RBAC).',
  })
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @ApiPropertyOptional({
    description: `Page size. Default ${DEFAULT_PAGE_SIZE}, maximum ${MAX_PAGE_SIZE}.`,
    minimum: 1,
    maximum: MAX_PAGE_SIZE,
    default: DEFAULT_PAGE_SIZE,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  limit?: number;

  @ApiPropertyOptional({
    description: 'Opaque keyset cursor from the previous response’s `nextCursor`.',
  })
  @IsOptional()
  @IsString()
  cursor?: string;
}
