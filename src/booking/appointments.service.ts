import { Injectable, Logger } from '@nestjs/common';
import { getCorrelationId } from '../common/correlation/correlation';
import { AppException } from '../common/errors/app.exception';
import { type Principal, PrincipalRole } from '../common/auth/principal';
import { clampLimit, decodeCursor, encodeCursor } from '../common/pagination/keyset';
import { PrismaService } from '../prisma/prisma.service';
import type { AppointmentRow } from './dto/appointment.response';
import type { ListAppointmentsQueryDto } from './dto/list-appointments.dto';

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
  cancelled_at    AS "cancelledAt",
  cancel_reason   AS "cancelReason",
  created_at      AS "createdAt"
`;

export interface AppointmentPage {
  items: AppointmentRow[];
  nextCursor: string | null;
}

@Injectable()
export class AppointmentsService {
  private readonly logger = new Logger(AppointmentsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Reads are scoped by tenant **and** by role. A CUSTOMER principal sees only their own rows —
   * tenant scoping alone is necessary but not sufficient, since roles differ inside one
   * dealership (§14). An appointment outside that scope is reported as absent, not forbidden.
   */
  async findById(principal: Principal, id: string): Promise<AppointmentRow> {
    const rows = await this.prisma.$queryRawUnsafe<AppointmentRow[]>(
      `SELECT ${APPOINTMENT_COLUMNS}
         FROM appointments
        WHERE id = $1::uuid
          AND dealership_id = $2::uuid
          AND ($3::uuid IS NULL OR customer_id = $3::uuid)`,
      id,
      principal.dealershipId,
      this.customerScope(principal),
    );

    const appointment = rows[0];
    if (!appointment) throw AppException.notFound('Appointment', id);
    return appointment;
  }

  /**
   * Keyset pagination over `(start_time, id)` descending (§7.2). The compound key matters:
   * `start_time` is not unique, so paginating on it alone would drop or repeat rows that share
   * an instant — exactly the case a busy dealership produces.
   */
  async list(principal: Principal, query: ListAppointmentsQueryDto): Promise<AppointmentPage> {
    const limit = clampLimit(query.limit);
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;

    // Fetch one extra row to learn whether another page exists, without a second COUNT query.
    const rows = await this.prisma.$queryRawUnsafe<AppointmentRow[]>(
      `SELECT ${APPOINTMENT_COLUMNS}
         FROM appointments
        WHERE dealership_id = $1::uuid
          AND ($2::uuid  IS NULL OR customer_id   = $2::uuid)
          AND ($3::text  IS NULL OR status        = $3::appointment_status)
          AND ($4::uuid  IS NULL OR technician_id = $4::uuid)
          AND ($5::uuid  IS NULL OR customer_id   = $5::uuid)
          AND ($6::timestamptz IS NULL OR start_time >= $6::timestamptz)
          AND ($7::timestamptz IS NULL OR start_time <  $7::timestamptz)
          AND ($8::timestamptz IS NULL OR (start_time, id) < ($8::timestamptz, $9::uuid))
        ORDER BY start_time DESC, id DESC
        LIMIT $10`,
      principal.dealershipId,
      this.customerScope(principal),
      query.status ?? null,
      query.technicianId ?? null,
      query.customerId ?? null,
      query.from ?? null,
      query.to ?? null,
      cursor?.startTime ?? null,
      cursor?.id ?? null,
      limit + 1,
    );

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items[items.length - 1];

    return {
      items,
      nextCursor:
        hasMore && last
          ? encodeCursor({ startTime: last.startTime.toISOString(), id: last.id })
          : null,
    };
  }

  /**
   * Cancel — **idempotent** (§5.2).
   *
   * The explicit `SELECT ... FOR UPDATE` is what makes that possible. A bare
   * `UPDATE ... WHERE status='CONFIRMED'` affecting zero rows cannot distinguish "no such
   * appointment" from "already cancelled", and would have to answer 404 or 409 to a perfectly
   * reasonable retry. Locking the row first separates the two: 404 only when the id does not
   * exist in this tenant, 200 in both other cases.
   *
   * Because the exclusion constraints are partial on `status='CONFIRMED'`, the window is free
   * for re-booking the instant this commits — no delete, no compaction.
   */
  async cancel(principal: Principal, id: string, reason?: string): Promise<AppointmentRow> {
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRawUnsafe<{ id: string; status: string }[]>(
        `SELECT id, status
           FROM appointments
          WHERE id = $1::uuid
            AND dealership_id = $2::uuid
            AND ($3::uuid IS NULL OR customer_id = $3::uuid)
          FOR UPDATE`,
        id,
        principal.dealershipId,
        this.customerScope(principal),
      );

      const row = locked[0];
      if (!row) throw AppException.notFound('Appointment', id);

      if (row.status === 'CANCELLED') {
        // Already cancelled: a no-op 200, never an ALREADY_CANCELLED error. A retried cancel is
        // a success, not a conflict.
        const rows = await tx.$queryRawUnsafe<AppointmentRow[]>(
          `SELECT ${APPOINTMENT_COLUMNS} FROM appointments WHERE id = $1::uuid`,
          id,
        );
        return rows[0]!;
      }

      const updated = await tx.$queryRawUnsafe<AppointmentRow[]>(
        `UPDATE appointments
            SET status = 'CANCELLED', cancelled_at = now(), cancel_reason = $2, updated_at = now()
          WHERE id = $1::uuid
        RETURNING ${APPOINTMENT_COLUMNS}`,
        id,
        reason ?? null,
      );

      const appointment = updated[0]!;

      // Same transaction as the status change, for the same reason the booking path does it:
      // the cancellation and the intent to announce it commit together or not at all (ADR-006).
      await tx.$executeRawUnsafe(
        `INSERT INTO outbox (dealership_id, aggregate_type, aggregate_id, event_type, payload)
         VALUES ($1::uuid, 'appointment', $2::uuid, 'AppointmentCancelled', $3::jsonb)`,
        appointment.dealershipId,
        appointment.id,
        JSON.stringify({
          appointmentId: appointment.id,
          dealershipId: appointment.dealershipId,
          customerId: appointment.customerId,
          technicianId: appointment.technicianId,
          serviceBayId: appointment.serviceBayId,
          startTime: appointment.startTime.toISOString(),
          endTime: appointment.endTime.toISOString(),
          cancelReason: reason ?? null,
          correlationId: getCorrelationId(),
        }),
      );

      this.logger.log(
        { correlationId: getCorrelationId(), appointmentId: appointment.id, outcome: 'cancelled' },
        'Appointment cancelled — slot freed',
      );

      return appointment;
    });
  }

  /** NULL for staff (all rows in the tenant); the customer's own id for a self-service caller. */
  private customerScope(principal: Principal): string | null {
    return principal.role === PrincipalRole.CUSTOMER ? (principal.customerId ?? null) : null;
  }
}
