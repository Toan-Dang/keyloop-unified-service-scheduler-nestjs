import { closeRedis } from './db';

/**
 * The suite helpers keep one Redis connection alive for flushing the idempotency cache between
 * tests. Closing it here — automatically, for every db-backed spec file — means no individual
 * suite has to remember, and Jest exits cleanly instead of hanging on an open handle.
 */
afterAll(async () => {
  await closeRedis();
});
