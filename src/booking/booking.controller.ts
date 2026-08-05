import { Body, Controller, Headers, HttpCode, HttpStatus, Post, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentPrincipal } from '../common/auth/current-principal.decorator';
import type { Principal } from '../common/auth/principal';
import { AppException } from '../common/errors/app.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { fingerprintRequestBody } from '../common/idempotency/fingerprint';
import { IdempotencyService } from '../common/idempotency/idempotency.service';
import { BookingService } from './booking.service';
import { AppointmentResponse } from './dto/appointment.response';
import { CreateAppointmentDto } from './dto/create-appointment.dto';
import { APPOINTMENT_WRITE_THROTTLE } from './write-throttle';

export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

@ApiTags('appointments')
@ApiBearerAuth('bearer')
@Controller('appointments')
export class BookingController {
  constructor(
    private readonly booking: BookingService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Throttle(APPOINTMENT_WRITE_THROTTLE)
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
  @ApiBadRequestResponse({
    description:
      'VALIDATION_ERROR — malformed body, a past start time, or a missing Idempotency-Key.',
  })
  @ApiNotFoundResponse({
    description:
      'NOT_FOUND — the customer, vehicle or service type does not exist within the caller’s dealership.',
  })
  @ApiConflictResponse({
    description: 'NO_AVAILABILITY — no (technician, bay) pair is free for the requested window.',
  })
  @ApiUnprocessableEntityResponse({
    description:
      'VEHICLE_OWNERSHIP_MISMATCH, NO_QUALIFIED_TECHNICIAN, OUTSIDE_WORKING_HOURS or IDEMPOTENCY_KEY_REUSE.',
  })
  @ApiTooManyRequestsResponse({ description: 'RATE_LIMITED — includes a Retry-After header.' })
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

    const requestHash = fingerprintRequestBody(dto);

    // --- Redis fast path (§6.3) ------------------------------------------------------------
    // Purely an optimisation. It can be skipped, cold, or evicted without affecting
    // correctness: the durable `(dealership_id, idempotency_key)` index and the persisted
    // `request_hash` carry the actual guarantee. The check-then-act race here is benign for the
    // same reason — whichever request reaches INSERT second hits 23505 and replays.
    const cached = await this.idempotency.lookup(principal.dealershipId, key);
    if (cached) {
      if (cached.requestHash !== requestHash) {
        throw AppException.idempotencyKeyReuse(key);
      }
      if (cached.status === HttpStatus.CONFLICT) {
        // A cached 409 is short-lived by design; while it is warm, replay it rather than
        // re-running allocation for a client hammering a slot that is still taken.
        throw AppException.noAvailability({ replayedFromCache: true });
      }
      res.status(cached.status);
      return cached.body as AppointmentResponse;
    }

    try {
      const outcome = await this.booking.createAppointment(principal, dto, { key, requestHash });
      const body = AppointmentResponse.from(outcome.appointment);

      await this.idempotency.remember(principal.dealershipId, key, {
        status: HttpStatus.CREATED,
        requestHash,
        body,
      });

      // An idempotent replay returns the ORIGINAL 201 (§7.1), not a 200 — the client cannot tell
      // its retry apart from its first call, which is the entire promise.
      res.status(HttpStatus.CREATED);
      return body;
    } catch (err) {
      if (err instanceof AppException && err.code === ErrorCode.NO_AVAILABILITY) {
        // Cached for ~60s only. Availability is time-sensitive: once the entry expires a retry
        // re-runs allocation, which is correct — the slot may since have freed. Replaying a
        // stale 409 forever would be wrong (§6.3).
        await this.idempotency.remember(principal.dealershipId, key, {
          status: HttpStatus.CONFLICT,
          requestHash,
          body: null,
        });
      }
      throw err;
    }
  }
}
