import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import type { AppConfig } from '../../config/configuration';

/**
 * Redis is the **idempotency fast path only** — never part of the correctness path (ADR-002,
 * §10.1). Every method here therefore fails soft: a Redis outage degrades replay speed, it does
 * not fail a booking. The durable guarantee lives in the `(dealership_id, idempotency_key)`
 * unique index.
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly client: Redis;
  private healthy = false;

  constructor(config: ConfigService) {
    const redis = config.getOrThrow<AppConfig['redis']>('redis');
    this.client = new Redis(redis.url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      retryStrategy: (attempt) => Math.min(attempt * 200, 5000),
    });

    this.client.on('error', (err: Error) => {
      if (this.healthy) {
        this.logger.warn({ err: err.message }, 'Redis connection error — degrading to DB-only');
      }
      this.healthy = false;
    });
    this.client.on('ready', () => {
      this.healthy = true;
      this.logger.log('Redis ready');
    });
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.client.connect();
    } catch (err) {
      // Non-fatal by design: readiness reports `degraded`, not `not-ready` (§13).
      this.logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'Redis unavailable at startup — continuing without the idempotency fast path',
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect();
    }
  }

  isHealthy(): boolean {
    return this.healthy;
  }

  async ping(): Promise<boolean> {
    try {
      const pong = await this.client.ping();
      this.healthy = pong === 'PONG';
      return this.healthy;
    } catch {
      this.healthy = false;
      return false;
    }
  }

  async get(key: string): Promise<string | null> {
    try {
      return await this.client.get(key);
    } catch (err) {
      this.warnOnce('get', key, err);
      return null;
    }
  }

  async setEx(key: string, value: string, ttlSeconds: number): Promise<void> {
    try {
      await this.client.set(key, value, 'EX', ttlSeconds);
    } catch (err) {
      this.warnOnce('setEx', key, err);
    }
  }

  /** SET NX EX — returns true when this caller won the slot. */
  async setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    try {
      const result = await this.client.set(key, value, 'EX', ttlSeconds, 'NX');
      return result === 'OK';
    } catch (err) {
      this.warnOnce('setIfAbsent', key, err);
      return false;
    }
  }

  async del(key: string): Promise<void> {
    try {
      await this.client.del(key);
    } catch (err) {
      this.warnOnce('del', key, err);
    }
  }

  private warnOnce(op: string, key: string, err: unknown): void {
    this.logger.debug(
      { op, key, err: err instanceof Error ? err.message : String(err) },
      'Redis operation failed — falling back to the durable path',
    );
  }
}
