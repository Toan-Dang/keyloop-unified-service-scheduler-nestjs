import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AvailabilityService, type Candidate } from '../availability/availability.service';
import { getCorrelationId } from '../common/correlation/correlation';
import { MetricsService } from '../common/metrics/metrics.service';
import type { AppConfig } from '../config/configuration';
import { PrismaService } from '../prisma/prisma.service';
import type { Sql } from '../prisma/tx';
import { CONSTRAINT, constraintOf, isSqlState, SQLSTATE, sqlStateOf } from './pg-error';

export interface AllocationCommand {
  dealershipId: string;
  customerId: string;
  vehicleId: string;
  serviceTypeId: string;
  requiredSkills: readonly string[];
  start: Date;
  end: Date;
  idempotencyKey: string | null;
  requestHash: string | null;
  /** Event rows to write in the SAME transaction as the appointment (ADR-006). */
  buildOutboxEvents?: (appointment: AllocatedAppointment) => readonly OutboxEventDraft[];
}

export interface OutboxEventDraft {
  eventType: string;
  aggregateType: string;
  payload: Record<string, unknown>;
}

export interface AllocatedAppointment {
  id: string;
  dealershipId: string;
  customerId: string;
  vehicleId: string;
  serviceTypeId: string;
  technicianId: string;
  serviceBayId: string;
  startTime: Date;
  endTime: Date;
  status: 'CONFIRMED' | 'CANCELLED';
  idempotencyKey: string | null;
  requestHash: string | null;
  createdAt: Date;
}

export type AllocationResult =
  | { outcome: 'created'; appointment: AllocatedAppointment; candidatesTried: number }
  | { outcome: 'idempotent-replay'; appointment: AllocatedAppointment; candidatesTried: number }
  | { outcome: 'no-availability'; candidatesTried: number };

/**
 * The allocation loop — the core of the system (§6.2).
 *
 * Shape, and why each piece is there:
 *
 *   BEGIN (READ COMMITTED)                deliberately not SERIALIZABLE: correctness lives in the
 *                                         physical write-time constraint, not in a snapshot, so
 *                                         the cheaper level is sufficient. SERIALIZABLE would buy
 *                                         retries and overhead and no extra guarantee.
 *     SET LOCAL lock_timeout = '2s'       an insert conflicting with an *uncommitted* row BLOCKS
 *                                         rather than failing; without this cap one hot slot
 *                                         could pin a request indefinitely.
 *     for each (technician, bay):         in deterministic order, so every request acquires locks
 *                                         in the same order and deadlocks stay rare.
 *       SAVEPOINT                         because ANY error — 23P01 included — aborts the WHOLE
 *                                         transaction on PostgreSQL. "Catch the error and insert
 *                                         the next candidate" simply does not work without this;
 *                                         the next statement fails with 25P02. This is the single
 *                                         most important implementation detail in the file.
 *       INSERT appointment + outbox       both, atomically, so a committed booking can never lose
 *                                         its notification (ADR-006).
 *       23P01 / 55P03 -> ROLLBACK TO SAVEPOINT, try next candidate
 *       23505         -> the idempotency backstop fired: a concurrent retry of this same request
 *                        already committed. Return that row rather than erroring.
 *       success       -> RELEASE, COMMIT
 *   COMMIT with nothing inserted -> 409 NO_AVAILABILITY
 *
 * 40P01 (deadlock) is handled *outside* the loop: abort and re-run the whole thing as a fresh
 * transaction, bounded. That is a deliberate robustness choice rather than a necessity — a
 * deadlock is savepoint-recoverable like any other error, but it signals a lock-ordering clash,
 * and continuing under the locks we already hold would likely just deadlock again.
 */
@Injectable()
export class AllocationService {
  private readonly logger = new Logger(AllocationService.name);
  private readonly booking: AppConfig['booking'];

  constructor(
    private readonly prisma: PrismaService,
    private readonly availability: AvailabilityService,
    private readonly metrics: MetricsService,
    config: ConfigService,
  ) {
    this.booking = config.getOrThrow<AppConfig['booking']>('booking');
  }

  /** Runs `attemptBooking`, restarting the whole transaction on 40P01 within a bounded budget. */
  async allocate(command: AllocationCommand): Promise<AllocationResult> {
    const stopTimer = this.metrics.bookingTransactionSeconds.startTimer();
    this.metrics.bookingAttemptsTotal.inc();

    let lastDeadlock: unknown;

    for (let attempt = 0; attempt <= this.booking.deadlockRetries; attempt += 1) {
      try {
        const result = await this.attemptBooking(command);

        stopTimer({ outcome: result.outcome });
        this.metrics.bookingCandidateAttempts.observe(
          { outcome: result.outcome },
          result.candidatesTried,
        );
        if (result.outcome === 'created') this.metrics.bookingConfirmedTotal.inc();
        if (result.outcome === 'no-availability') {
          this.metrics.bookingConflictsTotal.inc({ reason: 'candidates-exhausted' });
        }
        return result;
      } catch (err) {
        if (!isSqlState(err, SQLSTATE.DEADLOCK_DETECTED)) {
          stopTimer({ outcome: 'error' });
          throw err;
        }

        // A fresh transaction re-reads candidates from scratch, which is the point: whatever
        // the other transaction was doing has by now resolved one way or the other.
        lastDeadlock = err;
        this.metrics.bookingDeadlockRetriesTotal.inc();
        this.logger.warn(
          {
            correlationId: getCorrelationId(),
            attempt: attempt + 1,
            sqlState: SQLSTATE.DEADLOCK_DETECTED,
          },
          'Deadlock detected — restarting the whole booking transaction',
        );
      }
    }

    stopTimer({ outcome: 'deadlock-exhausted' });
    this.metrics.bookingConflictsTotal.inc({ reason: 'deadlock-exhausted' });
    throw lastDeadlock;
  }

  /** One transaction: read candidates, then try each under its own savepoint. */
  private async attemptBooking(command: AllocationCommand): Promise<AllocationResult> {
    return this.prisma.$transaction(
      async (tx) => {
        // Immediately after BEGIN and before any SAVEPOINT: a ROLLBACK TO SAVEPOINT must never
        // be able to discard the transaction-local settings (§14 makes the same point about the
        // RLS tenant GUC, which is set at exactly this spot in production).
        await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${this.booking.lockTimeoutMs}ms'`);

        // Read on THIS connection, inside THIS transaction, so a deadlock restart re-reads.
        const candidates = await this.availability.findCandidates(
          {
            dealershipId: command.dealershipId,
            requiredSkills: command.requiredSkills,
            start: command.start,
            end: command.end,
          },
          tx,
        );

        let tried = 0;

        for (const candidate of candidates) {
          tried += 1;
          const savepoint = `candidate_${tried}`;

          await tx.$executeRawUnsafe(`SAVEPOINT ${savepoint}`);

          try {
            const appointment = await this.insertAppointment(tx, command, candidate);
            await this.insertOutboxEvents(tx, command, appointment);
            await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${savepoint}`);

            this.logger.log(
              {
                correlationId: getCorrelationId(),
                appointmentId: appointment.id,
                technicianId: appointment.technicianId,
                serviceBayId: appointment.serviceBayId,
                candidatesTried: tried,
                outcome: 'confirmed',
              },
              'Booking confirmed',
            );
            return { outcome: 'created', appointment, candidatesTried: tried };
          } catch (err) {
            const sqlState = sqlStateOf(err);

            // A deadlock is not recoverable *here* by choice — rethrow so allocate() can restart
            // the whole transaction with fresh candidates.
            if (sqlState === SQLSTATE.DEADLOCK_DETECTED) throw err;

            if (sqlState === SQLSTATE.UNIQUE_VIOLATION) {
              // The durable idempotency backstop fired: a concurrent retry of this very request
              // committed first. Recover the savepoint, then return that row as success — the
              // client gets the same appointment either way, which is the whole promise of the
              // Idempotency-Key (§6.3).
              await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${savepoint}`);
              const existing = await this.findByIdempotencyKey(tx, command);
              if (existing) {
                this.logger.log(
                  {
                    correlationId: getCorrelationId(),
                    appointmentId: existing.id,
                    constraint: constraintOf(err) ?? CONSTRAINT.IDEMPOTENCY_KEY_UNIQUE,
                    outcome: 'idempotent-replay',
                  },
                  'Concurrent retry of the same request already committed',
                );
                return {
                  outcome: 'idempotent-replay',
                  appointment: existing,
                  candidatesTried: tried,
                };
              }
              // A unique violation with no matching row is not something we understand; do not
              // paper over it.
              throw err;
            }

            if (sqlState === SQLSTATE.EXCLUSION_VIOLATION || sqlState === SQLSTATE.LOCK_TIMEOUT) {
              // 23P01: someone committed this technician/bay window between our SELECT and our
              //        INSERT. Expected — it is exactly what the loop is for.
              // 55P03: a conflicting row is still in flight and we waited long enough. Don't let
              //        one hot slot pin the request; move on.
              await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${savepoint}`);
              this.logger.debug(
                {
                  correlationId: getCorrelationId(),
                  sqlState,
                  constraint: constraintOf(err),
                  technicianId: candidate.technicianId,
                  serviceBayId: candidate.serviceBayId,
                },
                'Candidate lost the race — trying the next pair',
              );
              continue;
            }

            throw err;
          }
        }

        // -----------------------------------------------------------------------------------
        // Candidates exhausted — but before calling it a conflict, check whether the thing that
        // beat us was our OWN concurrent twin.
        //
        // §6.3 says a same-key retry "hits 23505 and returns the existing appointment". That is
        // not what PostgreSQL does when both retries target the same slot: the INSERT violates
        // the exclusion constraint AND the idempotency unique index, and PostgreSQL reports
        // whichever index has the lower OID — the exclusion constraint, created first. So the
        // loop sees 23P01, treats it as a lost race, exhausts its candidates, and would answer
        // 409 to a client that is merely retrying its own booking.
        //
        // Re-reading the key here restores the documented guarantee regardless of which
        // constraint fired. Under READ COMMITTED each statement takes a fresh snapshot, so the
        // twin's committed row is visible even though our transaction started before it.
        // -----------------------------------------------------------------------------------
        if (command.idempotencyKey) {
          const twin = await this.findByIdempotencyKey(tx, command);
          if (twin) {
            this.logger.log(
              {
                correlationId: getCorrelationId(),
                appointmentId: twin.id,
                outcome: 'idempotent-replay',
              },
              'Candidates exhausted, but this request had already committed concurrently',
            );
            return { outcome: 'idempotent-replay', appointment: twin, candidatesTried: tried };
          }
        }

        // Nothing was inserted, so this commits an empty transaction. The caller maps it to
        // 409 NO_AVAILABILITY — a genuine state conflict, not a validation failure (§7.1).
        this.logger.log(
          { correlationId: getCorrelationId(), candidatesTried: tried, outcome: 'no-availability' },
          'No candidate pair could be allocated',
        );
        return { outcome: 'no-availability', candidatesTried: tried };
      },
      {
        // Prisma's default (~5s) would kill a transaction that legitimately spent up to
        // lock_timeout waiting on a hot slot plus the loop's own work (§6.2 ORM note).
        timeout: this.booking.txTimeoutMs,
        maxWait: this.booking.txTimeoutMs,
        // Explicit, and the whole point: the constraint carries correctness (§6.2).
        isolationLevel: 'ReadCommitted',
      },
    );
  }

  private async insertAppointment(
    tx: Sql,
    command: AllocationCommand,
    candidate: Candidate,
  ): Promise<AllocatedAppointment> {
    const rows = await tx.$queryRawUnsafe<AllocatedAppointment[]>(
      `
      INSERT INTO appointments
        (dealership_id, customer_id, vehicle_id, service_type_id,
         technician_id, service_bay_id, start_time, end_time, idempotency_key, request_hash)
      VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
              $7::timestamptz, $8::timestamptz, $9, $10)
      RETURNING id,
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
      `,
      command.dealershipId,
      command.customerId,
      command.vehicleId,
      command.serviceTypeId,
      candidate.technicianId,
      candidate.serviceBayId,
      command.start,
      command.end,
      command.idempotencyKey,
      command.requestHash,
    );

    const appointment = rows[0];
    if (!appointment) throw new Error('INSERT ... RETURNING produced no row');
    return appointment;
  }

  /**
   * The outbox rows go in **this** transaction, not after it (ADR-006). Either the appointment
   * and the intent-to-notify both commit, or neither does — which closes both halves of the
   * dual-write problem at once: no notification for a booking that rolled back, and no lost
   * notification for one that committed.
   */
  private async insertOutboxEvents(
    tx: Sql,
    command: AllocationCommand,
    appointment: AllocatedAppointment,
  ): Promise<void> {
    const events = command.buildOutboxEvents?.(appointment) ?? [];
    for (const event of events) {
      await tx.$executeRawUnsafe(
        `INSERT INTO outbox (dealership_id, aggregate_type, aggregate_id, event_type, payload)
         VALUES ($1::uuid, $2, $3::uuid, $4, $5::jsonb)`,
        appointment.dealershipId,
        event.aggregateType,
        appointment.id,
        event.eventType,
        JSON.stringify(event.payload),
      );
    }
  }

  /**
   * Looks up the row the 23505 collided with. Scoped to the caller's dealership as well as the
   * key — the uniqueness is `(dealership_id, idempotency_key)`, and re-checking the tenant here
   * means a replay can never hand back another dealership's appointment (§6.3).
   */
  private async findByIdempotencyKey(
    tx: Sql,
    command: AllocationCommand,
  ): Promise<AllocatedAppointment | null> {
    if (!command.idempotencyKey) return null;

    const rows = await tx.$queryRawUnsafe<AllocatedAppointment[]>(
      `SELECT id,
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
         FROM appointments
        WHERE dealership_id = $1::uuid AND idempotency_key = $2`,
      command.dealershipId,
      command.idempotencyKey,
    );
    return rows[0] ?? null;
  }
}
