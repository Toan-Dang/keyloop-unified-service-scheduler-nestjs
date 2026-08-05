import { Injectable } from '@nestjs/common';
import { AvailabilityService } from '../availability/availability.service';
import { AppException } from '../common/errors/app.exception';
import { getCorrelationId } from '../common/correlation/correlation';
import { PrismaService } from '../prisma/prisma.service';
import type { Principal } from '../common/auth/principal';
import { findAppointmentByIdempotencyKey } from './appointment-columns';
import {
  AllocationService,
  type AllocationCommand,
  type AllocatedAppointment,
} from './allocation.service';
import type { CreateAppointmentDto } from './dto/create-appointment.dto';

export interface BookingOutcome {
  appointment: AllocatedAppointment;
  /** True when the appointment already existed and this request replayed it (§6.3). */
  replayed: boolean;
}

interface ServiceTypeRow {
  id: string;
  durationMinutes: number;
  requiredSkills: string[];
}

interface CustomerVehicleRow {
  customerId: string | null;
  vehicleId: string | null;
  vehicleOwnerId: string | null;
}

@Injectable()
export class BookingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly allocation: AllocationService,
    private readonly availability: AvailabilityService,
  ) {}

  async createAppointment(
    principal: Principal,
    dto: CreateAppointmentDto,
    idempotency: { key: string; requestHash: string },
    now: Date = new Date(),
  ): Promise<BookingOutcome> {
    // ---------------------------------------------------------------------------------------
    // Durable idempotency check, BEFORE allocation (§5.1, §6.3).
    //
    // This has to come first, and the reason is easy to miss: on a sequential retry the original
    // appointment already occupies the slot, so `findCandidates` returns nothing, the allocation
    // loop never reaches an INSERT, and the in-loop 23505 replay path never fires. Without this
    // pre-check a client retrying after a network timeout would get `409 NO_AVAILABILITY` —
    // blamed for colliding with its own booking.
    //
    // The in-loop 23505 handler is still needed, but for the *other* case: two retries racing
    // each other, where both pass this check before either commits.
    //
    // It is a database read, not a cache read, so the guarantee holds with Redis cold — which is
    // the whole point of persisting `request_hash` on the row (db §5.4).
    // ---------------------------------------------------------------------------------------
    const existing = await findAppointmentByIdempotencyKey(
      this.prisma,
      principal.dealershipId,
      idempotency.key,
    );
    if (existing) {
      return { appointment: this.assertSameRequest(existing, idempotency), replayed: true };
    }

    // ---------------------------------------------------------------------------------------
    // Deterministic pre-checks (§5.1, §7.1), in the documented order.
    //
    // "Deterministic" is the operative word: each depends only on the request and on reference
    // data, never on live resource availability. That is what makes them safe to answer before
    // the transaction and what separates a 4xx the client can fix from a 409 it cannot.
    // ---------------------------------------------------------------------------------------
    const start = new Date(dto.desiredStartTime);
    if (Number.isNaN(start.getTime())) {
      throw AppException.validation('desiredStartTime is not a valid instant', {
        field: 'desiredStartTime',
      });
    }
    if (start.getTime() < now.getTime()) {
      throw AppException.validation('desiredStartTime is in the past', {
        field: 'desiredStartTime',
        desiredStartTime: dto.desiredStartTime,
      });
    }

    // Tenant-scoped, so a service type belonging to another dealership simply does not exist
    // from this caller's view — 404, not 403; no existence leak (§7, §14).
    const serviceType = await this.loadServiceType(principal.dealershipId, dto.serviceTypeId);
    const end = new Date(start.getTime() + serviceType.durationMinutes * 60_000);

    await this.assertCustomerAndVehicle(principal.dealershipId, dto);

    // A configuration miss ("nobody here holds `brakes`") is NOT the same failure as "the one
    // who does is busy". The first is 422 and permanent until someone changes the roster; the
    // second is 409 and might succeed on retry (§7.1).
    if (
      !(await this.availability.hasQualifiedTechnician(
        principal.dealershipId,
        serviceType.requiredSkills,
      ))
    ) {
      throw AppException.noQualifiedTechnician(serviceType.id, serviceType.requiredSkills);
    }

    // Dealership OPENING hours only — a property of the request alone, so it is a pre-check.
    // A window inside opening hours but outside every technician's individual *working* hours is
    // deliberately NOT this error: that is a per-technician availability fact and comes back as
    // 409 NO_AVAILABILITY from the loop (§7.1).
    if (!(await this.availability.withinOpeningHours(principal.dealershipId, start, end))) {
      throw AppException.outsideWorkingHours({
        startTime: start.toISOString(),
        endTime: end.toISOString(),
      });
    }

    const command: AllocationCommand = {
      dealershipId: principal.dealershipId,
      customerId: dto.customerId,
      vehicleId: dto.vehicleId,
      serviceTypeId: serviceType.id,
      requiredSkills: serviceType.requiredSkills,
      start,
      end,
      idempotencyKey: idempotency.key,
      requestHash: idempotency.requestHash,
      buildOutboxEvents: (appointment) => [
        {
          aggregateType: 'appointment',
          eventType: 'AppointmentConfirmed',
          payload: {
            appointmentId: appointment.id,
            dealershipId: appointment.dealershipId,
            customerId: appointment.customerId,
            vehicleId: appointment.vehicleId,
            serviceTypeId: appointment.serviceTypeId,
            technicianId: appointment.technicianId,
            serviceBayId: appointment.serviceBayId,
            startTime: appointment.startTime.toISOString(),
            endTime: appointment.endTime.toISOString(),
            // Carried onto the event so an async notification traces back to its booking (§13).
            correlationId: getCorrelationId(),
          },
        },
      ],
    };

    const result = await this.allocation.allocate(command);

    if (result.outcome === 'no-availability') {
      // A genuine state conflict — qualified technicians exist (we just checked), but every
      // (technician, bay) pair for this window is taken. 409, not 422 (§7.1).
      throw AppException.noAvailability({
        candidatesTried: result.candidatesTried,
        startTime: start.toISOString(),
        endTime: end.toISOString(),
      });
    }

    if (result.outcome === 'idempotent-replay') {
      return {
        appointment: this.assertSameRequest(result.appointment, idempotency),
        replayed: true,
      };
    }

    return { appointment: result.appointment, replayed: false };
  }

  /**
   * The key is a promise that the request is identical. A known key arriving with a different
   * fingerprint is rejected rather than silently replaying the prior result, which would hand
   * the client an appointment for a booking it did not make (§6.3).
   */
  private assertSameRequest(
    appointment: AllocatedAppointment,
    idempotency: { key: string; requestHash: string },
  ): AllocatedAppointment {
    if (appointment.requestHash && appointment.requestHash !== idempotency.requestHash) {
      throw AppException.idempotencyKeyReuse(idempotency.key);
    }
    return appointment;
  }

  private async loadServiceType(
    dealershipId: string,
    serviceTypeId: string,
  ): Promise<ServiceTypeRow> {
    const rows = await this.prisma.$queryRawUnsafe<ServiceTypeRow[]>(
      `SELECT id, duration_minutes AS "durationMinutes", required_skills AS "requiredSkills"
         FROM service_types
        WHERE id = $1::uuid AND dealership_id = $2::uuid`,
      serviceTypeId,
      dealershipId,
    );

    const serviceType = rows[0];
    if (!serviceType) throw AppException.notFound('ServiceType', serviceTypeId);
    return serviceType;
  }

  /**
   * Resolves both references in one round trip and distinguishes the two failures that look
   * alike: "does not exist in this tenant" (404) versus "exists here but belongs to a different
   * customer" (422 VEHICLE_OWNERSHIP_MISMATCH).
   */
  private async assertCustomerAndVehicle(
    dealershipId: string,
    dto: CreateAppointmentDto,
  ): Promise<void> {
    const rows = await this.prisma.$queryRawUnsafe<CustomerVehicleRow[]>(
      `SELECT c.id AS "customerId",
              v.id AS "vehicleId",
              v.customer_id AS "vehicleOwnerId"
         FROM (SELECT 1) AS anchor
         LEFT JOIN customers c ON c.id = $2::uuid AND c.dealership_id = $1::uuid
         LEFT JOIN vehicles  v ON v.id = $3::uuid AND v.dealership_id = $1::uuid`,
      dealershipId,
      dto.customerId,
      dto.vehicleId,
    );

    const row = rows[0];
    if (!row?.customerId) throw AppException.notFound('Customer', dto.customerId);
    if (!row.vehicleId) throw AppException.notFound('Vehicle', dto.vehicleId);
    if (row.vehicleOwnerId !== dto.customerId) {
      throw AppException.vehicleOwnershipMismatch(dto.vehicleId, dto.customerId);
    }
  }
}
