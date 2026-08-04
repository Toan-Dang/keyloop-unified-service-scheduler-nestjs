import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/configuration';
import { RedisService } from '../redis/redis.service';
import { idempotencyCacheKey } from './fingerprint';

/** What a previous request with this key produced. */
export interface CachedOutcome {
  status: HttpStatus;
  requestHash: string;
  body: unknown;
}

/**
 * The Redis **fast path** for idempotency (§6.3) — and nothing more.
 *
 * The durable guarantee lives in the `(dealership_id, idempotency_key)` unique index plus the
 * persisted `request_hash`; this layer only makes rapid retries cheap. Every method therefore
 * fails soft: with Redis down, bookings still work and duplicates are still impossible, they
 * just cost a full allocation round trip (§10.1, ADR-002).
 *
 * TTLs are asymmetric on purpose:
 *
 *   201 → ~24h. The DB row is the durable record anyway; this only saves work.
 *   409 → ~60s, and deliberately NOT durable. Availability is time-sensitive: the slot may have
 *         freed since. Replaying a stale 409 forever would be *wrong*, so letting it expire and
 *         re-running allocation is the correct behaviour, not a limitation.
 */
@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);
  private readonly ttl: AppConfig['idempotency'];

  constructor(
    private readonly redis: RedisService,
    config: ConfigService,
  ) {
    this.ttl = config.getOrThrow<AppConfig['idempotency']>('idempotency');
  }

  async lookup(dealershipId: string, key: string): Promise<CachedOutcome | null> {
    const raw = await this.redis.get(idempotencyCacheKey(dealershipId, key));
    if (!raw) return null;

    try {
      return JSON.parse(raw) as CachedOutcome;
    } catch {
      // A corrupt entry is not worth failing a booking over — drop it and take the slow path.
      this.logger.debug({ key }, 'Discarding unparseable idempotency cache entry');
      return null;
    }
  }

  async remember(dealershipId: string, key: string, outcome: CachedOutcome): Promise<void> {
    const ttlSeconds =
      outcome.status === HttpStatus.CREATED
        ? this.ttl.createdTtlSeconds
        : this.ttl.conflictTtlSeconds;

    await this.redis.setEx(
      idempotencyCacheKey(dealershipId, key),
      JSON.stringify(outcome),
      ttlSeconds,
    );
  }
}
