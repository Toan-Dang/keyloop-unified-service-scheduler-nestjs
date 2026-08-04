import { Injectable } from '@nestjs/common';
import { MetricsService } from '../common/metrics/metrics.service';
import { PrismaService } from '../prisma/prisma.service';
import type { Sql } from '../prisma/tx';

/** One bookable placement: a qualified, free technician paired with a free bay. */
export interface Candidate {
  technicianId: string;
  serviceBayId: string;
}

export interface CandidateQuery {
  dealershipId: string;
  requiredSkills: readonly string[];
  start: Date;
  end: Date;
}

@Injectable()
export class AvailabilityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * The **one** definition of "available" (§6.7). Both the booking allocation loop and
   * `GET /availability` call this, so the preview and the booking decision can never diverge on
   * what the word means.
   *
   * Advisory, always. It narrows the search; it never decides correctness — another request can
   * commit in the gap between this SELECT and our INSERT, and the exclusion constraint is what
   * settles that (§6.1). Treating this result as authoritative would be exactly the
   * check-then-insert race the whole design exists to avoid.
   *
   * Evaluated in **one set-returning query** so the candidate set is computed atomically against
   * current data rather than assembled from several round trips.
   *
   * `ORDER BY t.id, b.id` is not cosmetic: every request walking candidates in the same order
   * gives a consistent lock-acquisition order, which is what makes deadlocks (40P01) rare
   * instead of routine (§6.2).
   */
  async findCandidates(query: CandidateQuery, executor?: Sql): Promise<Candidate[]> {
    const client = executor ?? this.prisma;
    const stopTimer = this.metrics.availabilityCheckSeconds.startTimer();

    try {
      return await client.$queryRawUnsafe<Candidate[]>(
        `
        SELECT t.id AS "technicianId", b.id AS "serviceBayId"
          FROM dealerships  d
          JOIN technicians  t ON t.dealership_id = d.id AND t.is_active
          JOIN service_bays b ON b.dealership_id = d.id AND b.is_active
         WHERE d.id = $1::uuid
           -- Qualification: the technician's skills must be a SUPERSET of what the service
           -- requires. GIN-indexed containment (db §4).
           AND t.skills @> $2::text[]
           -- The window must fit inside a single contiguous range of BOTH the technician's shift
           -- and the dealership's opening hours (§6.7).
           AND hours_contains(t.working_hours, $3::timestamptz, $4::timestamptz, d.timezone)
           AND hours_contains(d.opening_hours, $3::timestamptz, $4::timestamptz, d.timezone)
           -- Mirrors the exclusion constraints, but advisory only — the constraint is the
           -- authority (§6.1). Uses the same && operator over the same generated range, so the
           -- advisory answer and the authoritative one at least agree on the arithmetic.
           AND NOT EXISTS (
                 SELECT 1 FROM appointments a
                  WHERE a.status = 'CONFIRMED'
                    AND a.technician_id = t.id
                    AND a.during && tstzrange($3::timestamptz, $4::timestamptz, '[)'))
           AND NOT EXISTS (
                 SELECT 1 FROM appointments a
                  WHERE a.status = 'CONFIRMED'
                    AND a.service_bay_id = b.id
                    AND a.during && tstzrange($3::timestamptz, $4::timestamptz, '[)'))
         ORDER BY t.id, b.id
        `,
        query.dealershipId,
        [...query.requiredSkills],
        query.start,
        query.end,
      );
    } finally {
      stopTimer();
    }
  }

  /**
   * How many appointments could actually be placed in this window.
   *
   * **Not** the size of the candidate list. A booking consumes one technician *and* one bay, so
   * the cross-product overstates capacity — two technicians and two bays yield four candidate
   * pairs but only two bookable slots. `min(distinct free technicians, distinct free bays)` is
   * the honest number (§7.2).
   */
  static bookableCount(candidates: readonly Candidate[]): number {
    const technicians = new Set(candidates.map((c) => c.technicianId));
    const bays = new Set(candidates.map((c) => c.serviceBayId));
    return Math.min(technicians.size, bays.size);
  }

  /**
   * Is there any technician at this dealership qualified for the service *at all*, ignoring
   * hours and existing bookings?
   *
   * This separates two failures that look alike from the outside but are not: a configuration
   * miss ("nobody here can do brakes" → `422 NO_QUALIFIED_TECHNICIAN`) versus a state conflict
   * ("the one who can is busy" → `409 NO_AVAILABILITY`). §7.1 draws that line deliberately.
   */
  async hasQualifiedTechnician(
    dealershipId: string,
    requiredSkills: readonly string[],
    executor?: Sql,
  ): Promise<boolean> {
    const client = executor ?? this.prisma;
    const rows = await client.$queryRawUnsafe<{ exists: boolean }[]>(
      `SELECT EXISTS (
         SELECT 1 FROM technicians t
          WHERE t.dealership_id = $1::uuid AND t.is_active AND t.skills @> $2::text[]
       ) AS "exists"`,
      dealershipId,
      [...requiredSkills],
    );
    return rows[0]?.exists ?? false;
  }

  /** Does the window sit inside the dealership's opening hours? A property of the request alone. */
  async withinOpeningHours(
    dealershipId: string,
    start: Date,
    end: Date,
    executor?: Sql,
  ): Promise<boolean> {
    const client = executor ?? this.prisma;
    const rows = await client.$queryRawUnsafe<{ ok: boolean }[]>(
      `SELECT hours_contains(d.opening_hours, $2::timestamptz, $3::timestamptz, d.timezone) AS ok
         FROM dealerships d WHERE d.id = $1::uuid`,
      dealershipId,
      start,
      end,
    );
    return rows[0]?.ok ?? false;
  }
}
