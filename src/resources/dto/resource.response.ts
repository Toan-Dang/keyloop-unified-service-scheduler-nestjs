import { ApiProperty } from '@nestjs/swagger';

export class DealershipResponse {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ description: 'IANA timezone used to interpret opening hours.' })
  timezone!: string;

  @ApiProperty({
    description: 'Weekly opening hours as local wall-clock ranges per weekday.',
    example: { mon: [['08:00', '18:00']], sun: [] },
  })
  openingHours!: unknown;
}

export class ServiceTypeResponse {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ description: 'Server-authoritative; determines the booking window.' })
  durationMinutes!: number;

  @ApiProperty({ type: [String], description: 'A technician qualifies iff their skills ⊇ this.' })
  requiredSkills!: string[];
}

export class TechnicianResponse {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ type: [String] })
  skills!: string[];

  @ApiProperty({ example: { mon: [['08:00', '17:00']] } })
  workingHours!: unknown;

  @ApiProperty()
  isActive!: boolean;
}

export class ServiceBayResponse {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  isActive!: boolean;
}
