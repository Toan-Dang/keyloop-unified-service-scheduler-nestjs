import { constraintOf, isSqlState, sqlStateOf } from '../../src/booking/pg-error';

/**
 * `sqlStateOf`/`constraintOf` unwrap three different error shapes (see the doc comment in
 * `pg-error.ts`). `test/integration/pg-error.spec.ts` proves branches 1–2 against a REAL Prisma
 * error; branch 3 — the message-regex "last resort" — is not something the current Prisma version
 * is ever observed to take (nothing here claims otherwise), so it has no such measured coverage.
 * These pin the regex's contract in isolation: if an edit to `pg-error.ts` breaks the pattern,
 * this fails immediately with a clear cause, rather than the fallback silently starting to return
 * `undefined` and only being noticed if some future Prisma version ever needs it.
 */
describe('pg-error.ts — the message-regex fallback (no structured code or meta at all)', () => {
  it('extracts the SQLSTATE from `Code: `XXXXX`` in the message', () => {
    const err = { message: 'Raw query failed. Code: `23P01`. Message: `conflict`' };

    expect(sqlStateOf(err)).toBe('23P01');
    expect(isSqlState(err, '23P01')).toBe(true);
  });

  it('extracts the constraint name from `constraint "name"` in the message', () => {
    const err = { message: 'duplicate key value violates constraint "no_technician_overlap"' };

    expect(constraintOf(err)).toBe('no_technician_overlap');
  });

  it('falls back to `index "name"` when the message names an index instead of a constraint', () => {
    const err = { message: 'ERROR: could not create exclusion index "no_bay_overlap"' };

    expect(constraintOf(err)).toBe('no_bay_overlap');
  });

  it('returns undefined rather than throwing when neither shape is present', () => {
    expect(sqlStateOf({ message: 'connection reset' })).toBeUndefined();
    expect(constraintOf({ message: 'connection reset' })).toBeUndefined();
    expect(sqlStateOf(null)).toBeUndefined();
    expect(sqlStateOf('not even an object')).toBeUndefined();
  });
});
