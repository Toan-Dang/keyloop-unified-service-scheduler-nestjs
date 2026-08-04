/**
 * The availability rule, in one place (§6.7).
 *
 * "Availability is computed by **one shared function** … used by *both* the booking allocation
 * loop and the `GET /availability` preview — so the two can never diverge on what 'available'
 * means."
 *
 * That guarantee needs care in the implementation, because the two callers cannot literally run
 * the same query: booking evaluates a **single window**, while the preview evaluates a **whole
 * day** in one set-based pass (§7.2) — calling the single-window query per slot would be the
 * per-slot round trip the design rules out.
 *
 * So the *predicates* live here as builders and both queries compose from them. Copying the SQL
 * into the preview instead would compile and pass today, then silently drift the first time
 * anyone edits one copy — and a preview that disagrees with booking is worse than no preview,
 * because it is confidently wrong.
 */

/** Technician's skills ⊇ the service's required skills. GIN-indexed containment (db §4). */
export function technicianQualified(technician: string, requiredSkills: string): string {
  return `${technician}.skills @> ${requiredSkills}::text[]`;
}

/** The window fits inside a single contiguous range of the technician's shift. */
export function technicianWithinHours(
  technician: string,
  start: string,
  end: string,
  timezone: string,
): string {
  return `hours_contains(${technician}.working_hours, ${start}, ${end}, ${timezone})`;
}

/** The window fits inside a single contiguous range of the dealership's opening hours. */
export function dealershipWithinHours(
  dealership: string,
  start: string,
  end: string,
  timezone: string,
): string {
  return `hours_contains(${dealership}.opening_hours, ${start}, ${end}, ${timezone})`;
}

/**
 * No CONFIRMED appointment for this resource overlaps the window.
 *
 * Mirrors the exclusion constraint and uses the same `&&` operator over the same generated
 * `during` column — but it is **advisory**. The constraint is the authority (§6.1); this only
 * narrows the search. Sharing the operator at least means the advisory answer and the
 * authoritative one agree on the arithmetic.
 */
export function resourceFree(
  column: 'technician_id' | 'service_bay_id',
  resource: string,
  start: string,
  end: string,
): string {
  return `NOT EXISTS (
            SELECT 1 FROM appointments a
             WHERE a.status = 'CONFIRMED'
               AND a.${column} = ${resource}.id
               AND a.during && tstzrange(${start}, ${end}, '[)'))`;
}
