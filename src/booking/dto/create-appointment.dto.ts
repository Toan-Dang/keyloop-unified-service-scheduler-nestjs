import { ApiProperty } from '@nestjs/swagger';
import { IsISO8601, IsUUID, Matches } from 'class-validator';

/**
 * `class-validator`'s `@IsISO8601({ strict: true })` accepts an offset-less datetime (e.g.
 * `"2026-09-07T02:00:00"`) as valid ISO 8601 — but `new Date(...)` on that string is parsed in
 * the **host process's local timezone**, not UTC (ECMA-262 Date Time String format). Golden Rule
 * 8 (§2, §6.7) requires `desiredStartTime` to be a UTC instant; without this, a client omitting
 * the offset would get its booking window silently computed against the wrong instant on any
 * host whose local TZ isn't UTC. Requires a trailing `Z` or a numeric `±HH:MM` offset — either is
 * unambiguous regardless of host timezone.
 */
const HAS_TIMEZONE_DESIGNATOR = /(Z|[+-]\d{2}:\d{2})$/;

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
      '`[desiredStartTime, desiredStartTime + durationMinutes)`. Must carry an explicit ' +
      'timezone designator (a trailing `Z` or a numeric offset) — an offset-less datetime is ' +
      'rejected rather than silently reinterpreted in the server’s local timezone.',
    format: 'date-time',
    example: '2026-09-07T02:00:00Z',
  })
  @IsISO8601({ strict: true })
  @Matches(HAS_TIMEZONE_DESIGNATOR, {
    message: 'desiredStartTime must include an explicit UTC offset (e.g. a trailing "Z")',
  })
  desiredStartTime!: string;
}
