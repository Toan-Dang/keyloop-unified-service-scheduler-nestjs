import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Matches, Max, Min } from 'class-validator';

export class AvailabilityQueryDto {
  @ApiProperty({ format: 'uuid', description: 'The service to preview availability for.' })
  @IsUUID()
  serviceTypeId!: string;

  @ApiProperty({
    description:
      'The day to enumerate, as a **dealership-local** calendar date (YYYY-MM-DD) — not a UTC ' +
      'date. "Tuesday" means Tuesday where the dealership is.',
    example: '2026-09-07',
  })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must be YYYY-MM-DD' })
  date!: string;

  @ApiPropertyOptional({
    description: 'Spacing between candidate start times, in minutes.',
    default: 30,
    minimum: 5,
    maximum: 240,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(5)
  @Max(240)
  granularityMinutes?: number;
}

export class AvailabilitySlotResponse {
  @ApiProperty({ format: 'date-time', description: 'Candidate start instant (UTC).' })
  startTime!: string;

  @ApiProperty({
    description:
      'How many appointments could actually be placed at this slot — ' +
      '`min(free qualified technicians, free bays)`, since a booking consumes one of each.',
    example: 2,
  })
  bookable!: number;
}

export class AvailabilityResponse {
  @ApiProperty({ example: '2026-09-07', description: 'The dealership-local date requested.' })
  date!: string;

  @ApiProperty({ format: 'uuid' })
  serviceTypeId!: string;

  @ApiProperty({ description: 'IANA timezone the date was interpreted in.' })
  timezone!: string;

  @ApiProperty({
    description:
      'Advisory only. The authoritative decision happens at POST time under the exclusion ' +
      'constraint, so a slot shown here may still return 409.',
    type: [AvailabilitySlotResponse],
  })
  slots!: AvailabilitySlotResponse[];
}
