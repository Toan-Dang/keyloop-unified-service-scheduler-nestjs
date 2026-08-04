import { Injectable } from '@nestjs/common';
import { AppException } from '../common/errors/app.exception';
import { getCorrelationId } from '../common/correlation/correlation';
import { PrismaService } from '../prisma/prisma.service';
import type { Principal } from '../common/auth/principal';
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

const APPOINTMENT_COLUMNS = `
  id,
  dealership_id   AS "dealershipId",
  customer_id     AS "customerId",
  vehicle_id      AS "vehicleId",
  service_type_id AS "serviceTypeId",
  technician_id   AS "technicianId",
  service_bay_id  AS "serviceBayId",
  start_time      AS "startTime",
  end_time        AS "endTime",
  status,
  idempotency_key AS "idempotencyKey",
  request_hash    AS "requestHash",
  created_at      AS "createdAt"
`;

@Injectable()
export class BookingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly allocation: AllocationService,
  ) {}

  async createAppointment(
    principal: Principal,
    dto: CreateAppointmentDto,
    idempotency: { key: string; requestHash: string },
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
    const existing = await this.findByIdempotencyKey(principal.dealershipId, idempotency.key);
    if (existing) {
      return { appointment: this.assertSameRequest(existing, idempotency), replayed: true };
    }

    // Duration is server-authoritative and tenant-scoped: a service type belonging to another
    // dealership simply does not exist from this caller's view (§7, §14).
    const serviceType = await this.loadServiceType(principal.dealershipId, dto.serviceTypeId);

    const start = new Date(dto.desiredStartTime);
    const end = new Date(start.getTime() + serviceType.durationMinutes * 60_000);

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
      // A genuine state conflict — qualified technicians may well exist, but every
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

  /** Scoped to the tenant as well as the key, so a replay can never cross dealerships (§6.3). */
  private async findByIdempotencyKey(
    dealershipId: string,
    idempotencyKey: string,
  ): Promise<AllocatedAppointment | null> {
    const rows = await this.prisma.$queryRawUnsafe<AllocatedAppointment[]>(
      `SELECT ${APPOINTMENT_COLUMNS}
         FROM appointments
        WHERE dealership_id = $1::uuid AND idempotency_key = $2`,
      dealershipId,
      idempotencyKey,
    );
    return rows[0] ?? null;
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
}
