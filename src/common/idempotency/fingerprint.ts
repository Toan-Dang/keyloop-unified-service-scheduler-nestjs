import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';

/**
 * Request fingerprint for idempotency (§6.3, §7).
 *
 * SHA-256 over **RFC 8785 (JCS)** canonical JSON — a defined standard rather than
 * `JSON.stringify`, so two independent implementations hash an equivalent body identically
 * (deterministic key ordering, normalised numbers and strings). Without that, a client that
 * happened to serialise its keys in a different order would look like a *different* request and
 * get a spurious `422 IDEMPOTENCY_KEY_REUSE`.
 *
 * Covers the booking fields only — not the URL, the method, or the key itself (§7).
 */
export function fingerprintRequestBody(body: unknown): string {
  const canonical = canonicalize(body);
  if (canonical === undefined) {
    throw new Error('Request body is not canonicalizable JSON');
  }
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Cache key for the Redis fast path. Scoped to the tenant, never the bare key — two dealerships
 * that happen to choose the same key value must not be able to read each other's response
 * (§6.3).
 */
export function idempotencyCacheKey(dealershipId: string, idempotencyKey: string): string {
  return `idem:${dealershipId}:${idempotencyKey}`;
}
