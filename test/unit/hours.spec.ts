import {
  localToUtc,
  offsetAt,
  parseClock,
  toLocalParts,
  windowFitsHours,
  type HoursSpec,
} from '../../src/availability/hours';

/**
 * Working/opening-hours arithmetic (§6.7) — the rules the design pins explicitly, each with a
 * test that would fail if the rule were relaxed.
 */
describe('hours evaluation (§6.7)', () => {
  const SAIGON = 'Asia/Ho_Chi_Minh'; // UTC+7, no DST — the seed dealership.
  const BERLIN = 'Europe/Berlin'; // observes DST — the fixture the DST cases need.

  /** Mon–Sat 08:00–18:00, closed Sunday. */
  const OPENING: HoursSpec = {
    mon: [['08:00', '18:00']],
    tue: [['08:00', '18:00']],
    wed: [['08:00', '18:00']],
    thu: [['08:00', '18:00']],
    fri: [['08:00', '18:00']],
    sat: [['08:00', '18:00']],
    sun: [],
  };

  /** A split shift with a lunch close — the case that makes "single range" meaningful. */
  const SPLIT: HoursSpec = {
    mon: [
      ['08:00', '12:00'],
      ['13:00', '17:00'],
    ],
  };

  /** 2026-09-07 is a Monday. Local 09:00 in Saigon (UTC+7) is 02:00Z. */
  const local = (hhmm: string, date = '2026-09-07'): Date => {
    const [h = 0, m = 0] = hhmm.split(':').map(Number);
    return new Date(Date.UTC(2026, 8, Number(date.slice(-2)), h - 7, m, 0));
  };

  describe('a window must fit inside a single contiguous range', () => {
    it('accepts a window wholly inside one range', () => {
      expect(windowFitsHours(OPENING, local('09:00'), local('10:30'), SAIGON)).toEqual({
        fits: true,
      });
    });

    it('accepts a window ending exactly at close — ranges are half-open', () => {
      expect(windowFitsHours(OPENING, local('16:30'), local('18:00'), SAIGON)).toEqual({
        fits: true,
      });
    });

    it('rejects a window starting exactly at close', () => {
      expect(windowFitsHours(OPENING, local('18:00'), local('19:00'), SAIGON)).toMatchObject({
        fits: false,
        reason: 'outside-every-range',
      });
    });

    it('rejects a window that starts before open', () => {
      expect(windowFitsHours(OPENING, local('07:30'), local('08:30'), SAIGON)).toMatchObject({
        fits: false,
        reason: 'outside-every-range',
      });
    });

    it('rejects a window that overruns close, even though it starts inside', () => {
      expect(windowFitsHours(OPENING, local('17:30'), local('18:30'), SAIGON)).toMatchObject({
        fits: false,
        reason: 'straddles-a-gap',
      });
    });

    it('REJECTS a window straddling the lunch gap — the whole point of the rule', () => {
      // 11:30–12:30 starts inside [08:00,12:00) and ends inside [13:00,17:00), but no SINGLE
      // range contains it. A job may not pause for lunch and resume.
      expect(windowFitsHours(SPLIT, local('11:30'), local('12:30'), SAIGON)).toMatchObject({
        fits: false,
        reason: 'straddles-a-gap',
      });
    });

    it('accepts the same duration moved wholly into the afternoon range', () => {
      expect(windowFitsHours(SPLIT, local('13:00'), local('14:00'), SAIGON)).toEqual({
        fits: true,
      });
    });

    it('rejects a window that falls entirely inside the lunch gap', () => {
      expect(windowFitsHours(SPLIT, local('12:15'), local('12:45'), SAIGON)).toMatchObject({
        fits: false,
        reason: 'outside-every-range',
      });
    });
  });

  describe('weekday buckets', () => {
    it('rejects a day with no ranges at all (closed Sunday)', () => {
      // 2026-09-13 is a Sunday.
      expect(windowFitsHours(OPENING, local('09:00', '13'), local('10:00', '13'), SAIGON)).toEqual({
        fits: false,
        reason: 'closed-that-day',
      });
    });

    it('buckets by the LOCAL weekday, not the UTC one', () => {
      // 2026-09-13T18:00Z is Sunday in UTC but already Monday 01:00 in Saigon (UTC+7).
      // Bucketing by UTC would wrongly read this as a closed Sunday.
      const start = new Date('2026-09-13T18:00:00Z');
      expect(toLocalParts(start, SAIGON).weekday).toBe('mon');
      expect(toLocalParts(start, 'UTC').weekday).toBe('sun');
    });
  });

  describe('midnight crossing', () => {
    it('rejects a window running into the next local day (§6.7, this iteration)', () => {
      const hours: HoursSpec = { mon: [['22:00', '23:59']] };
      const start = local('23:00');
      const end = new Date(start.getTime() + 120 * 60_000); // 01:00 next day
      expect(windowFitsHours(hours, start, end, SAIGON)).toMatchObject({
        fits: false,
        reason: 'crosses-midnight',
      });
    });

    it('treats an end at exactly local midnight as this day’s closing boundary, not the next day', () => {
      const hours: HoursSpec = { mon: [['22:00', '24:00']] };
      const start = local('23:00');
      const end = new Date(start.getTime() + 60 * 60_000); // exactly 00:00
      expect(windowFitsHours(hours, start, end, SAIGON)).toEqual({ fits: true });
    });
  });

  describe('parseClock', () => {
    it.each([
      ['00:00', 0],
      ['08:30', 510],
      ['18:00', 1080],
      ['24:00', 1440],
    ])('parses %s', (value, expected) => {
      expect(parseClock(value)).toBe(expected);
    });

    it.each(['8:00', '0800', '25:00', '08:99', ''])('rejects malformed %s loudly', (value) => {
      expect(() => parseClock(value)).toThrow();
    });
  });

  /**
   * DST bites in exactly ONE place (§6.7): the `GET /availability` enumeration, which builds
   * candidate start times from a dealership-LOCAL date and must convert local→UTC. That
   * direction is not single-valued. The booking path is immune, because `desiredStartTime`
   * arrives as a UTC instant and UTC→local always is single-valued.
   */
  describe('DST — local→UTC enumeration only', () => {
    it('SKIPS a local time inside the spring-forward gap, because no such instant exists', () => {
      // 2026-03-29, Europe/Berlin: 02:00 CET jumps straight to 03:00 CEST. 02:30 never happens.
      expect(localToUtc(BERLIN, 2026, 3, 29, 2 * 60 + 30)).toBeNull();
    });

    it('still resolves times either side of the gap', () => {
      expect(localToUtc(BERLIN, 2026, 3, 29, 60)?.toISOString()).toBe('2026-03-29T00:00:00.000Z');
      expect(localToUtc(BERLIN, 2026, 3, 29, 3 * 60)?.toISOString()).toBe(
        '2026-03-29T01:00:00.000Z',
      );
    });

    it('resolves a fall-back overlap to the EARLIER offset (documented choice)', () => {
      // 2026-10-25, Europe/Berlin: 03:00 CEST falls back to 02:00 CET, so local 02:30 happens
      // twice — first at 00:30Z (CEST, +2), again at 01:30Z (CET, +1). We take the earlier.
      expect(localToUtc(BERLIN, 2026, 10, 25, 2 * 60 + 30)?.toISOString()).toBe(
        '2026-10-25T00:30:00.000Z',
      );
    });

    it('round-trips cleanly in a zone with no DST', () => {
      const utc = localToUtc(SAIGON, 2026, 9, 7, 9 * 60);
      expect(utc?.toISOString()).toBe('2026-09-07T02:00:00.000Z');
      expect(toLocalParts(utc!, SAIGON).minutesOfDay).toBe(9 * 60);
    });

    it('reports the offset actually in force at an instant', () => {
      expect(offsetAt(new Date('2026-09-07T02:00:00Z'), SAIGON)).toBe(420); // UTC+7
      expect(offsetAt(new Date('2026-01-15T12:00:00Z'), BERLIN)).toBe(60); // CET
      expect(offsetAt(new Date('2026-07-15T12:00:00Z'), BERLIN)).toBe(120); // CEST
    });
  });
});
