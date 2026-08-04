import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { API_PREFIX } from '../../src/openapi';
import { AllExceptionsFilter } from '../../src/common/errors/all-exceptions.filter';
import { encodePrincipal } from '../../src/common/auth/tenant.guard';
import { PrincipalRole } from '../../src/common/auth/principal';
import { SEED } from '../../prisma/seed';
import { readTestEnv } from './test-database';

/**
 * Boots the real application — real guards, real pipes, real filter, real database. The
 * concurrency proof is worthless against a mocked stack, and the e2e suite is meant to exercise
 * the same wiring a reviewer gets from `npm run start:dev`.
 */
export async function createTestApp(
  overrides: { outboxRelay?: boolean; reminderCron?: boolean; redisUrl?: string } = {},
): Promise<INestApplication> {
  const env = readTestEnv();
  process.env.DATABASE_URL = env.databaseUrl;
  // A suite can point this at a dead port to prove bookings stay correct with Redis down.
  process.env.REDIS_URL = overrides.redisUrl ?? env.redisUrl;
  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = process.env.TEST_LOG_LEVEL ?? 'silent';
  // Background workers are opt-in per suite so their polling cannot perturb a timing-sensitive
  // concurrency measurement.
  process.env.OUTBOX_RELAY_ENABLED = String(overrides.outboxRelay ?? false);
  process.env.REMINDER_CRON_ENABLED = String(overrides.reminderCron ?? false);

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

  const app = moduleRef.createNestApplication({ bufferLogs: true });
  app.setGlobalPrefix(API_PREFIX, { exclude: ['health', 'ready', 'metrics'] });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());

  await app.init();
  // Bind an ephemeral port rather than stopping at init(). Supertest calls `server.listen(0)`
  // itself when handed a non-listening server, and firing N requests in parallel makes N of
  // those calls race — which surfaces as ECONNRESET once N gets large. Listening once up front
  // means every request just connects to an already-bound server. It matters here specifically
  // because this harness exists to be hammered concurrently.
  await app.listen(0);
  return app;
}

/** A STAFF token for the seeded dealership — the tenant a booking is made against. */
export function staffToken(dealershipId: string = SEED.dealership.id): string {
  return `Bearer ${encodePrincipal({ dealershipId, role: PrincipalRole.STAFF })}`;
}

/** A CUSTOMER token, whose reads are further restricted to their own rows (§14 RBAC). */
export function customerToken(
  customerId: string = SEED.customers.one.id,
  dealershipId: string = SEED.dealership.id,
): string {
  return `Bearer ${encodePrincipal({ dealershipId, role: PrincipalRole.CUSTOMER, customerId })}`;
}
