import { AppException } from '../errors/app.exception';

/**
 * Keyset (cursor) pagination — **not** OFFSET (§7.2).
 *
 * OFFSET makes the database scan and discard every skipped row, so page 500 costs 500 pages of
 * work; keyset seeks straight to the cursor and stays flat however deep the client goes. It also
 * cannot skip or duplicate rows when the underlying data shifts between pages, which OFFSET can.
 *
 * The cursor is an opaque base64 of `(start_time, id)` — opaque because it is an implementation
 * detail clients must not construct or reason about, and a compound key because `start_time`
 * alone is not unique.
 */
export interface Cursor {
  startTime: string;
  id: string;
}

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(`${cursor.startTime}|${cursor.id}`, 'utf8').toString('base64url');
}

export function decodeCursor(raw: string): Cursor {
  let decoded: string;
  try {
    decoded = Buffer.from(raw, 'base64url').toString('utf8');
  } catch {
    throw AppException.validation('Malformed cursor', { cursor: raw });
  }

  const separator = decoded.lastIndexOf('|');
  if (separator === -1) {
    throw AppException.validation('Malformed cursor', { cursor: raw });
  }

  const startTime = decoded.slice(0, separator);
  const id = decoded.slice(separator + 1);
  if (!startTime || !id || Number.isNaN(Date.parse(startTime))) {
    throw AppException.validation('Malformed cursor', { cursor: raw });
  }

  return { startTime, id };
}

export function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1) {
    throw AppException.validation('limit must be a positive integer', { limit });
  }
  return Math.min(limit, MAX_PAGE_SIZE);
}
