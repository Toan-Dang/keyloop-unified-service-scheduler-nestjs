import type { Prisma } from '../../generated/prisma/client';

/**
 * The subset of the client the query helpers need: anything that can run raw SQL.
 *
 * Typing against this rather than `PrismaService` is what lets `findCandidates` run either
 * standalone (its own connection) or *inside* the allocation transaction — which matters,
 * because the loop must re-read candidates on its connection after a deadlock restart.
 */
export type Sql = Pick<Prisma.TransactionClient, '$queryRawUnsafe' | '$executeRawUnsafe'>;
