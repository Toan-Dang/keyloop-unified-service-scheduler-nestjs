/**
 * Working / opening hours evaluation (§6.7).
 *
 * Hours are stored as **local wall-clock** ranges per weekday (JSONB), and windows are UTC
 * instants. Everything here is the arithmetic that connects the two, pinned to the semantics the
 * design fixes:
 *
 *   - the whole window must fit inside a **single contiguous range** — a job may not straddle a
 *     lunch gap;
 *   - ranges are half-open `[open, close)`, consistent with the overlap rule: a job ending
 *     exactly at close is allowed, one starting exactly at close is not;
 *   - a window crossing midnight into a different weekday bucket is rejected in this iteration.
 *
 * The booking path never hits a DST ambiguity: `desiredStartTime` arrives as a UTC instant and
 * UTC→local is single-valued. The gap/overlap problem lives only in the `GET /availability`
 * local→UTC enumeration — see `enumerateLocalStarts`.
 */

export type WeekdayKey = 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat';

const WEEKDAYS: readonly WeekdayKey[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** `{"mon": [["08:00","12:00"], ["13:00","18:00"]], "sun": []}` */
export type HoursSpec = Partial<Record<WeekdayKey, ReadonlyArray<readonly [string, string]>>>;

export interface LocalDateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: WeekdayKey;
  /** Minutes since local midnight. */
  minutesOfDay: number;
}

const partsFormatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = partsFormatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    partsFormatterCache.set(timeZone, formatter);
  }
  return formatter;
}

const WEEKDAY_BY_LABEL: Readonly<Record<string, WeekdayKey>> = {
  Sun: 'sun',
  Mon: 'mon',
  Tue: 'tue',
  Wed: 'wed',
  Thu: 'thu',
  Fri: 'fri',
  Sat: 'sat',
};

/** Converts a UTC instant to wall-clock parts in `timeZone`. Single-valued, always. */
export function toLocalParts(instant: Date, timeZone: string): LocalDateTimeParts {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const lookup = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '';

  // `hour12: false` can render midnight as "24" in some ICU versions; normalise it.
  const rawHour = Number.parseInt(lookup('hour'), 10);
  const hour = rawHour === 24 ? 0 : rawHour;
  const minute = Number.parseInt(lookup('minute'), 10);
  const weekday = WEEKDAY_BY_LABEL[lookup('weekday')];

  if (!weekday) {
    throw new Error(`Unrecognised weekday from timezone "${timeZone}"`);
  }

  return {
    year: Number.parseInt(lookup('year'), 10),
    month: Number.parseInt(lookup('month'), 10),
    day: Number.parseInt(lookup('day'), 10),
    hour,
    minute,
    second: Number.parseInt(lookup('second'), 10),
    weekday,
    minutesOfDay: hour * 60 + minute,
  };
}

/** "08:30" → 510. Throws on anything that is not HH:MM, so bad fixture data fails loudly. */
export function parseClock(value: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error(`Invalid wall-clock time "${value}" — expected HH:MM`);
  const hours = Number.parseInt(match[1]!, 10);
  const minutes = Number.parseInt(match[2]!, 10);
  if (hours > 24 || minutes > 59) throw new Error(`Invalid wall-clock time "${value}"`);
  return hours * 60 + minutes;
}

export function weekdayOf(instant: Date, timeZone: string): WeekdayKey {
  return toLocalParts(instant, timeZone).weekday;
}

export function weekdayFromIndex(index: number): WeekdayKey {
  const key = WEEKDAYS[((index % 7) + 7) % 7];
  if (!key) throw new Error(`Invalid weekday index ${index}`);
  return key;
}

export interface HoursCheckResult {
  fits: boolean;
  reason?: 'closed-that-day' | 'crosses-midnight' | 'outside-every-range' | 'straddles-a-gap';
}

/**
 * Does `[start, end)` fit inside a **single** range of the weekday it starts on?
 *
 * Mirrors the `hours_contains(...)` SQL helper so the TypeScript and SQL answers cannot diverge;
 * the SQL one is authoritative on the booking path (it runs inside `findCandidates`), and this
 * one exists so the rule is unit-testable without a database.
 */
export function windowFitsHours(
  hours: HoursSpec,
  start: Date,
  end: Date,
  timeZone: string,
): HoursCheckResult {
  const startParts = toLocalParts(start, timeZone);
  const endParts = toLocalParts(end, timeZone);

  const ranges = hours[startParts.weekday] ?? [];
  if (ranges.length === 0) return { fits: false, reason: 'closed-that-day' };

  // The end lands on a different local calendar day. Rejected in this iteration (§6.7) — with
  // one exception: ending at exactly local midnight is the *closing* boundary of the start day,
  // not a new day, and a half-open range treats it as such.
  const sameDay =
    startParts.year === endParts.year &&
    startParts.month === endParts.month &&
    startParts.day === endParts.day;
  const endsAtMidnight = endParts.minutesOfDay === 0 && endParts.second === 0;
  if (!sameDay && !endsAtMidnight) {
    return { fits: false, reason: 'crosses-midnight' };
  }

  const startMinutes = startParts.minutesOfDay;
  // Elapsed minutes, so an end at local midnight reads as 1440 rather than 0.
  const endMinutes = startMinutes + Math.round((end.getTime() - start.getTime()) / 60_000);

  let insideSomeRangeStart = false;
  for (const [open, close] of ranges) {
    const openMinutes = parseClock(open);
    const closeMinutes = parseClock(close);
    // Half-open: starting exactly at close is outside, ending exactly at close is inside.
    if (startMinutes >= openMinutes && startMinutes < closeMinutes) {
      insideSomeRangeStart = true;
      if (endMinutes <= closeMinutes) return { fits: true };
    }
  }

  // Distinguishing these two is worth the extra flag: "your 11:30 job runs into the lunch close"
  // is a different operational story from "we are shut at that hour".
  return { fits: false, reason: insideSomeRangeStart ? 'straddles-a-gap' : 'outside-every-range' };
}

/**
 * Builds the UTC instant for a local wall-clock time in `timeZone`, or `null` when that local
 * time **does not exist** (the spring-forward gap).
 *
 * This is the direction where DST actually bites (§6.7): local→UTC is not single-valued. During
 * a fall-back overlap the same local time maps to two instants; we resolve to the **earlier**
 * offset, as the design specifies.
 */
export function localToUtc(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  minutesOfDay: number,
): Date | null {
  const hour = Math.floor(minutesOfDay / 60);
  const minute = minutesOfDay % 60;

  // Treat the wall-clock as if it were UTC, then correct by the zone's offset.
  //
  // Probing with the offsets in force a day either side is what makes both DST cases fall out:
  // around a transition the two probes disagree, yielding the two distinct instants that a
  // fall-back overlap really has. Probing only once — or twice with the same seed — would find
  // just one of them and silently return the wrong side of the overlap.
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const DAY_MS = 86_400_000;

  const candidates: Date[] = [];
  for (const probe of [naive - DAY_MS, naive + DAY_MS]) {
    const instant = new Date(naive - offsetAt(new Date(probe), timeZone) * 60_000);
    if (!candidates.some((c) => c.getTime() === instant.getTime())) candidates.push(instant);
  }

  // Keep only instants that really do render back to the requested wall-clock — this is what
  // filters out a nonexistent local time in the spring-forward gap.
  const valid = candidates.filter((instant) => {
    const parts = toLocalParts(instant, timeZone);
    return (
      parts.year === year &&
      parts.month === month &&
      parts.day === day &&
      parts.minutesOfDay === minutesOfDay
    );
  });

  if (valid.length === 0) return null;
  // Fall-back overlap → earlier offset, i.e. the earlier instant (documented choice).
  return valid.reduce((earliest, c) => (c.getTime() < earliest.getTime() ? c : earliest));
}

/** Offset of `timeZone` from UTC, in minutes, at `instant` (positive east of Greenwich). */
export function offsetAt(instant: Date, timeZone: string): number {
  const parts = toLocalParts(instant, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return Math.round((asUtc - instant.getTime()) / 60_000);
}
