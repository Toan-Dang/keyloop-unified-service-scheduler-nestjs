import { Injectable } from '@nestjs/common';
import { AppException } from '../common/errors/app.exception';
import { PrismaService } from '../prisma/prisma.service';
import {
  dealershipWithinHours,
  resourceFree,
  technicianQualified,
  technicianWithinHours,
} from './candidate-sql';
import type { AvailabilityQueryDto, AvailabilityResponse } from './dto/availability.dto';
import { localToUtc } from './hours';

interface DealershipRow {
  timezone: string;
}

interface ServiceTypeRow {
  id: string;
  durationMinutes: number;
  requiredSkills: string[];
}

interface SlotCountRow {
  startTime: Date;
  technicians: number;
  bays: number;
}

@Injectable()
export class AvailabilityPreviewService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Enumerates a dealership-local day at `granularityMinutes` and reports how many appointments
   * each candidate start could actually take.
   *
   * Two things this deliberately is not:
   *
   *  - **Not a per-slot round trip.** The whole day is one set-based query; cost scales with
   *    slots-per-day, not with a network call each. That is why the strict p99 SLO is stated for
   *    the single-window check on the booking path and this preview is explicitly best-effort
   *    and cache-friendly (§7.2, §10).
   *  - **Not authoritative.** It shares the `findCandidates` rule so the two can never disagree
   *    about the *definition* of available, but the booking path's answer is the real one.
   */
  async previewDay(
    dealershipId: string,
    query: AvailabilityQueryDto,
  ): Promise<AvailabilityResponse> {
    const dealership = await this.loadDealership(dealershipId);
    const serviceType = await this.loadServiceType(dealershipId, query.serviceTypeId);
    const granularity = query.granularityMinutes ?? 30;

    const [year, month, day] = query.date.split('-').map(Number) as [number, number, number];

    // Build the day's candidate LOCAL start times, then convert each to UTC. This is the one
    // direction where DST bites (§6.7): local→UTC is not single-valued.
    const starts: Date[] = [];
    for (let minutes = 0; minutes < 24 * 60; minutes += granularity) {
      const instant = localToUtc(dealership.timezone, year, month, day, minutes);
      // `null` = this local time does not exist (spring-forward gap), so it is SKIPPED rather
      // than silently snapped to a neighbouring instant. A fall-back overlap resolves to the
      // earlier offset inside localToUtc.
      if (instant) starts.push(instant);
    }

    if (starts.length === 0) {
      return {
        date: query.date,
        serviceTypeId: serviceType.id,
        timezone: dealership.timezone,
        slots: [],
      };
    }

    const durationMs = serviceType.durationMinutes * 60_000;
    const ends = starts.map((s) => new Date(s.getTime() + durationMs));

    const rows = await this.prisma.$queryRawUnsafe<SlotCountRow[]>(
      `
      WITH windows AS (
        SELECT s.start_time, e.end_time
          FROM unnest($2::timestamptz[]) WITH ORDINALITY AS s(start_time, ord)
          JOIN unnest($3::timestamptz[]) WITH ORDINALITY AS e(end_time, ord) USING (ord)
      )
      SELECT w.start_time AS "startTime",
             -- DISTINCT because a technician appears once per free bay in this join, and vice
             -- versa; counting the raw pairs would overstate capacity.
             count(DISTINCT t.id)::int AS technicians,
             count(DISTINCT b.id)::int AS bays
        FROM windows w
        JOIN dealerships d ON d.id = $1::uuid
        LEFT JOIN technicians t
          ON t.dealership_id = d.id AND t.is_active
         AND ${technicianQualified('t', '$4')}
         AND ${technicianWithinHours('t', 'w.start_time', 'w.end_time', 'd.timezone')}
         AND ${resourceFree('technician_id', 't', 'w.start_time', 'w.end_time')}
        LEFT JOIN service_bays b
          ON b.dealership_id = d.id AND b.is_active
         AND ${resourceFree('service_bay_id', 'b', 'w.start_time', 'w.end_time')}
       WHERE ${dealershipWithinHours('d', 'w.start_time', 'w.end_time', 'd.timezone')}
       GROUP BY w.start_time
       ORDER BY w.start_time
      `,
      dealershipId,
      starts,
      ends,
      serviceType.requiredSkills,
    );

    return {
      date: query.date,
      serviceTypeId: serviceType.id,
      timezone: dealership.timezone,
      slots: rows
        // `bookable = min(free technicians, free bays)`, NOT the size of the candidate
        // cross-product — a booking consumes one of each, so two technicians and two bays yield
        // four pairs but only two bookable slots (§7.2).
        .map((row) => ({
          startTime: row.startTime.toISOString(),
          bookable: Math.min(row.technicians, row.bays),
        }))
        .filter((slot) => slot.bookable > 0),
    };
  }

  private async loadDealership(dealershipId: string): Promise<DealershipRow> {
    const rows = await this.prisma.$queryRawUnsafe<DealershipRow[]>(
      `SELECT timezone FROM dealerships WHERE id = $1::uuid`,
      dealershipId,
    );
    const dealership = rows[0];
    if (!dealership) throw AppException.notFound('Dealership', dealershipId);
    return dealership;
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
