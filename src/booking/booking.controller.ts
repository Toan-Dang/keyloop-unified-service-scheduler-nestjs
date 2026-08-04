import { Body, Controller, Headers, HttpCode, HttpStatus, Post, Res } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiHeader,
  ApiOperation,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentPrincipal } from '../common/auth/current-principal.decorator';
import type { Principal } from '../common/auth/principal';
import { AppException } from '../common/errors/app.exception';
import { fingerprintRequestBody } from '../common/idempotency/fingerprint';
import { BookingService } from './booking.service';
import { AppointmentResponse } from './dto/appointment.response';
import { CreateAppointmentDto } from './dto/create-appointment.dto';

export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

@ApiTags('appointments')
@ApiBearerAuth('bearer')
@Controller('appointments')
export class BookingController {
  constructor(private readonly booking: BookingService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Book a service appointment',
    description:
      'Allocates one qualified technician and one service bay for the whole service window. ' +
      'Whether the slot is free is decided by the database at write time, not by the preceding ' +
      'availability read — so a slot that looked open may still return 409.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description:
      'Required. Retrying with the same key returns the original appointment instead of ' +
      'creating a second one. Reusing a key with a different body is rejected with 422.',
  })
  @ApiCreatedResponse({ type: AppointmentResponse, description: 'Appointment confirmed.' })
  @ApiConflictResponse({
    description: 'NO_AVAILABILITY — no (technician, bay) pair is free for the requested window.',
  })
  @ApiUnprocessableEntityResponse({
    description:
      'IDEMPOTENCY_KEY_REUSE, VEHICLE_OWNERSHIP_MISMATCH, NO_QUALIFIED_TECHNICIAN or OUTSIDE_WORKING_HOURS.',
  })
  async create(
    @CurrentPrincipal() principal: Principal,
    @Body() dto: CreateAppointmentDto,
    @Headers(IDEMPOTENCY_KEY_HEADER) idempotencyKey: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AppointmentResponse> {
    const key = idempotencyKey?.trim();
    if (!key) {
      // A missing key is a malformed request, not a conflict — 400 per §7.1.
      throw AppException.validation('The Idempotency-Key header is required on this endpoint', {
        header: 'Idempotency-Key',
      });
    }

    const outcome = await this.booking.createAppointment(principal, dto, {
      key,
      requestHash: fingerprintRequestBody(dto),
    });

    // An idempotent replay returns the ORIGINAL 201 (§7.1), not a 200 — the client cannot tell
    // its retry apart from its first call, which is the entire promise.
    res.status(HttpStatus.CREATED);
    return AppointmentResponse.from(outcome.appointment);
  }
}
