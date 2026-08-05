import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { CurrentPrincipal } from '../common/auth/current-principal.decorator';
import type { Principal } from '../common/auth/principal';
import { AppointmentsService } from './appointments.service';
import { AppointmentPageResponse, AppointmentResponse } from './dto/appointment.response';
import { CancelAppointmentDto } from './dto/cancel-appointment.dto';
import { ListAppointmentsQueryDto } from './dto/list-appointments.dto';
import { UuidParamDto } from '../common/dto/uuid-param.dto';
import { APPOINTMENT_WRITE_THROTTLE } from './write-throttle';

@ApiTags('appointments')
@ApiBearerAuth('bearer')
@Controller('appointments')
export class AppointmentsController {
  constructor(private readonly appointments: AppointmentsService) {}

  @Get()
  @ApiOperation({
    summary: 'List appointments within the caller’s dealership',
    description:
      'Keyset (cursor) paginated, newest first. A CUSTOMER-role caller sees only their own ' +
      'appointments regardless of the `customerId` filter (§14 RBAC).',
  })
  @ApiOkResponse({ type: AppointmentPageResponse })
  async list(
    @CurrentPrincipal() principal: Principal,
    @Query() query: ListAppointmentsQueryDto,
  ): Promise<AppointmentPageResponse> {
    const page = await this.appointments.list(principal, query);
    return {
      items: page.items.map((row) => AppointmentResponse.from(row)),
      nextCursor: page.nextCursor,
    };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Fetch one appointment' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: AppointmentResponse })
  @ApiNotFoundResponse({
    description:
      'NOT_FOUND — no such appointment in the caller’s dealership (or outside their role scope).',
  })
  async findOne(
    @CurrentPrincipal() principal: Principal,
    @Param() params: UuidParamDto,
  ): Promise<AppointmentResponse> {
    return AppointmentResponse.from(await this.appointments.findById(principal, params.id));
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @Throttle(APPOINTMENT_WRITE_THROTTLE)
  @ApiOperation({
    summary: 'Cancel an appointment, freeing its slot',
    description:
      '**Idempotent**: returns 200 whether the appointment was CONFIRMED or already CANCELLED. ' +
      '404 only when the id does not exist within the caller’s dealership. There is deliberately ' +
      'no ALREADY_CANCELLED error — a retried cancel is a success, not a conflict.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: AppointmentResponse, description: 'Cancelled (or already was).' })
  @ApiNotFoundResponse({ description: 'NOT_FOUND — no such appointment in this dealership.' })
  @ApiTooManyRequestsResponse({ description: 'RATE_LIMITED — includes a Retry-After header.' })
  async cancel(
    @CurrentPrincipal() principal: Principal,
    @Param() params: UuidParamDto,
    @Body() dto: CancelAppointmentDto,
  ): Promise<AppointmentResponse> {
    return AppointmentResponse.from(
      await this.appointments.cancel(principal, params.id, dto.reason),
    );
  }
}
