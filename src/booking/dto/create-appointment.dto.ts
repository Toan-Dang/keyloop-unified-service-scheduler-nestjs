import { ApiProperty } from '@nestjs/swagger';
import { IsISO8601, IsUUID } from 'class-validator';

/**
 * The booking request (§7).
 *
 * Note what is **absent**: there is no `dealershipId`, and no duration or end time. The tenant
 * comes from the access token (§14) and the duration comes from the service type (§2,
 * assumption 1) — a client can neither name a tenant nor request an arbitrary-length slot. The
 * global ValidationPipe runs with `forbidNonWhitelisted`, so a body that tries to smuggle either
 * one in is rejected outright rather than silently stripped.
 */
export class CreateAppointmentDto {
  @ApiProperty({
    description: 'Customer requesting the service. Must exist within the caller’s dealership.',
    format: 'uuid',
    example: '01900000-0000-7000-8000-00000000ee01',
  })
  @IsUUID()
  customerId!: string;

  @ApiProperty({
    description: 'Vehicle to be serviced. Must be owned by `customerId`.',
    format: 'uuid',
    example: '01900000-0000-7000-8000-00000000ff01',
  })
  @IsUUID()
  vehicleId!: string;

  @ApiProperty({
    description: 'Service to perform. Its `durationMinutes` determines the booking window.',
    format: 'uuid',
    example: '01900000-0000-7000-8000-00000000cc02',
  })
  @IsUUID()
  serviceTypeId!: string;

  @ApiProperty({
    description:
      'Desired start, as a UTC instant. The window is the half-open interval ' +
      '`[desiredStartTime, desiredStartTime + durationMinutes)`.',
    format: 'date-time',
    example: '2026-09-07T02:00:00Z',
  })
  @IsISO8601({ strict: true })
  desiredStartTime!: string;
}
