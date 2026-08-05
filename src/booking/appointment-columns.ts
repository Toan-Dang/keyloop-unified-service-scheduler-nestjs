import type { Sql } from '../prisma/tx';
import type { AppointmentRow } from './dto/appointment.response';

/**
 * The full `appointments` row projection, snake_case → camelCase, shared by every raw-SQL read
 * and write in the booking module. One definition so a new column is added in exactly one place:
 * previously this list was hand-duplicated four times across `appointments.service.ts`,
 * `booking.service.ts` and `allocation.service.ts` — two of them named `APPOINTMENT_COLUMNS`
 * identically but with *different* columns, which is exactly the kind of drift a shared source
 * of truth exists to prevent (mirrors the `candidate-sql.ts` rationale for `findCandidates`, §6.7).
 *
 * Always selects every column, including the write-path-only (`idempotencyKey`/`requestHash`)
 * and cancel-path-only (`cancelledAt`/`cancelReason`) fields — harmless for callers that don't
 * need them (`AppointmentRow` declares both pairs optional), and it means one row shape,
 * `AppointmentRow`, serves reads, cancels, and the allocation loop alike.
 */
export const APPOINTMENT_COLUMNS = `
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
  cancelled_at    AS "cancelledAt",
  cancel_reason   AS "cancelReason",
  created_at      AS "createdAt"
`;

/**
 * Looks up an appointment by its durable `(dealership_id, idempotency_key)` key (§6.3). Scoped to
 * the tenant as well as the key, so a replay can never cross dealerships. Used both as
 * `BookingService`'s pre-allocation durable check and as `AllocationService`'s in-loop
 * 23505/post-exhaustion backstop — same query, two different transaction contexts, hence
 * `executor: Sql` rather than a concrete client type (satisfied by both `PrismaService` and a
 * `tx` inside `prisma.$transaction`). Previously hand-duplicated in both services.
 */
export async function findAppointmentByIdempotencyKey(
  executor: Sql,
  dealershipId: string,
  idempotencyKey: string,
): Promise<AppointmentRow | null> {
  const rows = await executor.$queryRawUnsafe<AppointmentRow[]>(
    `SELECT ${APPOINTMENT_COLUMNS}
       FROM appointments
      WHERE dealership_id = $1::uuid AND idempotency_key = $2`,
    dealershipId,
    idempotencyKey,
  );
  return rows[0] ?? null;
}
